# Astro Notification Service

Serviço do Astro que consulta o PostgreSQL, identifica situações que exigem
atenção e registra notificações no MongoDB para consumo pela `astro-api`.
Ele acompanha prazos mesmo quando ninguém acessa ou altera o sistema.

Cada regra é um **Cloudflare Worker independente**, com configuração, publicação
e execução próprias. Os Workers compartilham os módulos de acesso aos bancos,
configuração e persistência das notificações neste repositório.

Tarefa pai: [SCRUM-557 — Implementar serviço de notificações automáticas do Astro com Cloudflare Workers](https://luizacursino.atlassian.net/browse/SCRUM-557).

## Estado da entrega

Quatro análises estão implementadas. O quinto Worker, de obrigações sem registro,
está reservado e retorna `applicability_pending`, mesmo se alguém tentar habilitá-lo.

As quatro regras prontas usam `ENABLED=true` e `DRY_RUN=false` em produção.
Elas analisam **todos os workspaces**, inclusive os cadastrados posteriormente,
sem lista de IDs. O Worker de obrigações sem registro permanece desabilitado.
Os Workers de regras mantêm `triggers.crons=[]` e recebem chamadas internas.

O `astro-shared-scheduler` compartilha a agenda `0 * * * *` entre notificações e
resumos. Em **16/10/2026**, essa agenda substitui o Cron do
`astro-session-summary-service`, mantendo o total de cinco Cron Triggers na conta
gratuita. E-mails, limpeza de dados, RPA e atualização de NRs conservam suas agendas.
O estado desativado do processamento de resumos foi preservado.

## Workers e regras

| Identificador | Nome no Cloudflare | Responsabilidade | Execução pelo disparador |
| --- | --- | --- | --- |
| `expiring-compliance` | `astro-notification-expiring-compliance` | Conformidades próximas do vencimento | Diariamente, 08h em São Paulo |
| `expired-compliance` | `astro-notification-expired-compliance` | Conformidades vencidas | Diariamente, 08h em São Paulo |
| `class-deadlines` | `astro-notification-class-deadlines` | Participações pendentes próximas do prazo da turma | A cada hora, no minuto zero |
| `pending-validations` | `astro-notification-pending-validations` | Conclusões aguardando avaliação do gestor | Diariamente, 08h em São Paulo |
| `missing-compliance` | `astro-notification-missing-compliance` | Obrigações sem conformidade registrada | Sem agenda; aplicabilidade pendente |

### Disparador compartilhado

O sexto Worker, `astro-shared-scheduler`, possui a única agenda deste conjunto.
O binding `SUMMARY` aponta para o entrypoint `ScheduledJob` do serviço de resumos;
`CLASSES`, `EXPIRING`, `EXPIRED` e `VALIDATIONS` apontam para `RuleJob` de cada regra.
O disparador não acessa bancos nem recebe credenciais deles.

As chamadas usam Service Bindings RPC e aguardam a execução do método `run()` de
cada destino. Não há endpoint HTTP público de processamento. `Promise.allSettled`
garante que uma falha não suprima os outros disparos; o resultado geral ainda
registra a falha e a propaga ao runtime. Cada serviço respeita sua habilitação.

Resumos e turmas são chamados a cada hora. As outras três regras entram na mesma
execução quando o horário **original do evento agendado** está na hora UTC definida
em `DAILY_HOUR_UTC`, inicialmente 11h UTC (08h de São Paulo). Uma execução atrasada
usa o horário do evento, e não o relógio de início do handler, para selecionar tarefas.
Não há retentativa ou reconstrução automática de agendas perdidas.

O entrypoint interno `SchedulerControl` oferece `inspect()` para consultar os
destinos e `run(timestampEmMilissegundos)` para reexecutar um horário. A reexecução
respeita as flags reais dos serviços e pode gravar notificações. `RuleJob.preview()`
sempre usa simulação e permite conferir candidatos sem gravar, mesmo com a regra
habilitada em produção. A regra de obrigações sem registro não é disparada.

### Conformidades

As análises de validade consideram colaboradores ativos, com cargo e unidade
ativos, registros aplicáveis e NRs não revogadas. O cargo e a unidade precisam
pertencer ao mesmo workspace. As consultas incluem todos os workspaces e verificam
os vínculos para não misturar colaboradores, cargos, unidades ou responsáveis.

A seleção de um registro por colaborador e NR segue a precedência documentada
em `vw_conformidades`: aplicabilidade verdadeira primeiro, depois a maior
validade com nulos por último e, no empate, o maior ID. A consulta faz essa
seleção diretamente nas tabelas, sem exigir a instalação da view. Uma renovação
com validade maior impede que o registro vencido anterior gere uma nova cobrança.

O serviço usa a validade cadastrada; não calcula prazos legais a partir do número
da NR. Validade nula não gera aviso de vencimento. A validade de hoje continua
válida até o fim do dia em São Paulo; vencida é a data anterior a hoje.

- Próximas do vencimento: faixas configuráveis, inicialmente 30 e 7 dias. Um
  registro a 20 dias recebe o aviso da faixa de 30; a 5 dias recebe o de 7.
  Cada execução gera apenas a faixa mais próxima aplicável.
- Vencidas: um aviso por registro e validade. A primeira execução pode encontrar
  pendências antigas; não há repetição diária da mesma cobrança.
- Nesta versão, os avisos de conformidade são destinados ao próprio colaborador.
  Resumos e escalonamento para gestores permanecem como evolução.

### Turmas e validações

O aviso de turma considera evento ativo e prazo entre o momento atual e as
próximas 24 horas, por padrão. Ausência de conclusão, rejeição ou conclusão
pendente ainda sem data de envio representam pendência. Quem já enviou para
análise ou teve a conclusão validada não recebe essa cobrança. Prazos já
encerrados não entram nesta regra.

A análise de validações considera conclusões `PENDENTE`, com data de envio
preenchida e sem data de validação, aguardando há pelo menos 48 horas por padrão.
O destinatário é o gestor responsável pelo evento. Eventos cancelados são
excluídos; eventos concluídos ainda podem ter envios aguardando avaliação.
Um reenvio com nova data de conclusão permite um novo aviso.

Participantes e responsáveis precisam estar ativos e no mesmo workspace, com
cargos e unidades ativos. Os horários de turma e conclusão, armazenados como
`timestamp` sem fuso, são interpretados como horário de São Paulo.

### Obrigações sem registro

A existência de `cargo_nr` e `unidade_nr` ainda não define como combinar essas
exigências para cada pessoa. Antes de implementar essa análise, é preciso decidir
se os vínculos se somam, se dependem de interseção ou se têm papéis diferentes.
Também falta definir o tratamento das exceções de aplicabilidade.

Consultar apenas conformidades existentes não detecta uma obrigação que nunca
foi registrada. Por isso este Worker não reaproveita uma consulta de vencimentos
para tentar inferir ausência de registro.

## Fluxo de execução

1. Verificar se a regra está habilitada.
2. Consultar candidatos no PostgreSQL em transações somente de leitura, por lotes.
3. Montar as notificações e suas chaves de negócio.
4. Em simulação, contabilizar candidatos sem conectar ao MongoDB.
5. Com gravação habilitada, garantir índices e contador e gravar cada aviso em uma transação idempotente.
6. Registrar contagens e duração e fechar as conexões da execução.

A paginação usa o último ID consultado, sem `OFFSET`. Se `MAX_BATCHES` for
atingido e ainda houver candidatos, a execução falha com `BATCH_LIMIT_REACHED`;
ela não informa sucesso ocultando registros restantes. Ajuste a capacidade antes
da próxima execução. Falhas parciais podem ser reexecutadas:
os avisos já gravados serão reconhecidos pelas mesmas chaves.

As consultas são atuais por lote. PostgreSQL e MongoDB não participam de uma
transação distribuída; uma alteração na origem entre leitura e gravação pode
ocorrer. A frequência de execução não determina a frequência de notificação:
o mesmo fato não é recriado a cada consulta.

## Contrato no MongoDB

Collection: `notificacoes`. Cada nova notificação contém **somente** estes campos:

| Campo | Tipo BSON | Uso |
| --- | --- | --- |
| `_id` | Número | Inteiro positivo gerado pelo contador compartilhado |
| `id_usuario` | Número | Destinatário compatível com o modelo atual da API |
| `titulo` | String | Título preenchido em todas as novas notificações |
| `mensagem` | String | Texto exibido ao usuário |
| `data_criacao` | Date | Instante de criação do aviso, armazenado em UTC |
| `idevento` | Número, opcional | ID do evento nos avisos de prazo e de validação; ausente nos avisos de conformidade |

Exemplo completo em Extended JSON, sem campos adicionais:

```json
{
  "_id": 1,
  "id_usuario": 2,
  "mensagem": "Você tem uma participação pendente no evento “Treinamento”. O prazo termina em 2026-10-17 12:00:00 (horário de São Paulo).",
  "data_criacao": { "$date": "2026-10-16T12:00:00.000Z" },
  "idevento": 1,
  "titulo": "Prazo de evento próximo do fim"
}
```

`idevento` corresponde a `evento.id_evento`, convertido para número com validação
de precisão, e não ao ID da turma, da participação ou da conclusão. Os avisos de
conformidade omitem esse campo, sem gravar `null` ou um ID artificial.

Os títulos usados são “Conformidade próxima do vencimento”, “Conformidade
vencida”, “Prazo de evento próximo do fim” e “Conclusão aguardando avaliação”,
conforme a regra. O nome do evento permanece na mensagem.

Workspace, regra, recurso, versão e chave de deduplicação **não são gravados no
documento da notificação**. O controle fica separado:

- `notificacoes_controle`: `_id` é a chave estável de negócio e `notification_id`
  referencia o ID numérico do aviso. O índice único de `_id` impede repetir a
  chave; outro índice único impede associar o mesmo ID a duas chaves.
- `notificacoes_contadores`: o documento `_id: "notificacoes"` mantém `value`, o
  contador compartilhado pelos Workers. Na inicialização, `$max` garante um piso
  igual ao maior `_id` numérico já existente, sem diminuir o contador. O próximo
  ID parte de 1 quando não há IDs numéricos. ObjectIds antigos não entram no cálculo.

A chave conserva a composição anterior: versão, regra, workspace, destinatário,
recurso, data de referência e faixa. Antes de criar um aviso, o serviço consulta
o controle e as chaves da versão anterior em `notificacoes`. Assim, avisos antigos
com chave continuam reconhecidos sem serem regravados. Documentos legados sem
chave não permitem reconstruir sua identidade e são apenas preservados.

O incremento do contador, o registro de controle e a inserção do aviso pertencem
à **mesma transação MongoDB**. Uma falha desfaz as três operações e permite
reexecutar a mesma chave. Disputas concorrentes são tratadas pelo driver e pelo
controle único. Reexecuções não alteram título, mensagem ou data do aviso existente.
O MongoDB precisa suportar transações (replica set ou cluster fragmentado), e o
usuário da conexão precisa acessar as três collections e criar seus índices.
O cluster configurado foi validado com transações em collections temporárias.

Outros produtores de notificações numéricas devem usar o mesmo contador e
protocolo de gravação; não podem escolher `_id` manualmente em paralelo.

O índice de consulta é `(id_usuario ASC, data_criacao DESC, _id DESC)`. Os índices
são criados na primeira execução com gravação habilitada. Se o índice único não
puder ser garantido, nenhuma notificação será gravada por essa execução.
IDs incompatíveis com a precisão inteira do JavaScript são rejeitados, evitando
gravar um destinatário diferente por arredondamento.

O novo formato se aplica após publicar esta versão; não há migração automática
dos documentos existentes. A API precisa aceitar o histórico com ObjectId e os
novos IDs numéricos, além de mapear `titulo` e `idevento`. Em **16/10/2026**, a
`main` consultada da `astro-api` ainda declara `@MongoId(FieldType.OBJECT_ID)`
com ID `String` e não declara esses dois campos. O alinhamento desse consumidor
precisa ocorrer antes de liberar o novo contrato de ponta a ponta.

A Home do colaborador na `astro-api` consulta as três notificações mais recentes;
o estado de visualização é tratado pela API no Redis. A Home do gestor ainda
precisa incorporar o consumo desses avisos: persistir o alerta de validação não
adiciona automaticamente um novo bloco à interface do gestor.

Esta versão interrompe novas cobranças quando a situação deixa de ser elegível,
mas **não apaga nem oculta notificações antigas já gravadas**. Resolução de avisos,
histórico e filtragem de situações superadas exigem alinhamento com a API.

## Organização do repositório

```text
src/
  workers/       uma entrada por regra e uma para o disparador
  scheduler/     seleção das tarefas horárias e diárias e despacho independente
  rules/         consultas de candidatos por regra
  shared/        configuração, execução, PostgreSQL, MongoDB e notificações
workers/
  <regra>/wrangler.jsonc   configuração independente de publicação
scripts/         desenvolvimento, publicação, importação de credenciais e diagnóstico
tests/           regras, consultas SQL, persistência e execução
  runtime/       inicialização e eventos agendados dos cinco Workers no workerd
  integration/   contrato e transações no MongoDB real, somente por execução explícita
.github/workflows/ci.yml   validação automática sem credenciais de produção
```

## Desenvolvimento local

Requer Node.js 22 ou superior e npm. A CI usa Node.js 24.

```sh
npm ci
npm run check
npm test
npm run test:runtime
npm run build
```

Copie `.env.example` para `.env` e preencha as conexões de desenvolvimento. Para
importar somente as credenciais necessárias de um arquivo existente:

```sh
npm run credentials:import -- "C:/caminho/astro-ai-api/.env"
```

O importador copia apenas `DATABASE_URL`, `MONGODB_URI`, `MONGODB_DATABASE` e
`PG_CA_CERT` quando disponível, e não sobrescreve um `.env` existente.
Os arquivos de credenciais são ignorados pelo Git e os valores não são impressos.

```sh
npm run dev -- expiring-compliance
```

O comando `dev`, local ou remoto, gera uma configuração ignorada em `.wrangler/local`
com execução desabilitada e simulação habilitada nas regras, mesmo com produção
ativa. Variáveis explicitamente passadas pelo desenvolvedor podem sobrescrevê-la.
O modo local remove o Hyperdrive de produção e usa `DATABASE_URL`. Conexões diretas remotas exigem TLS
com certificado verificado; para o Aiven, forneça o CA em `PG_CA_CERT`.
Conexões locais sem TLS precisam indicar `sslmode=disable` explicitamente.

Com o servidor aberto, `GET /health` verifica somente o processo.
`GET /__scheduled` dispara o evento de teste do Wrangler. Para testar a consulta,
configure `ENABLED=true` e mantenha `DRY_RUN=true`. Todos os workspaces são analisados.

Para simular no Cloudflare usando o Hyperdrive já configurado:

```sh
npm run dev -- expired-compliance --remote --port 8787 --var ENABLED:true --var DRY_RUN:true
```

O modo remoto usa um preview temporário e pode acessar o banco real.
`DRY_RUN=true` impede gravações e criação de índices no MongoDB.

O diagnóstico local `npm run connections:check -- <arquivo-env>` apenas consulta
o schema do PostgreSQL e executa `ping` no MongoDB; não modifica registros.

## Configurações

| Variável ou binding | Padrão | Significado |
| --- | --- | --- |
| `ENABLED` | `true` nas quatro regras prontas | Habilita a análise; aceita apenas `true` ou `false`; fallback seguro `false` |
| `DRY_RUN` | `false` em produção | Simula sem abrir conexão de persistência com MongoDB quando `true`; fallback seguro `true` |
| `EXPIRY_WARNING_DAYS` | `30,7` | Antecedências em dias, até 365 |
| `CLASS_WARNING_HOURS` | `24` | Janela de proximidade do prazo, até 720 horas |
| `VALIDATION_WAIT_HOURS` | `48` | Tempo mínimo aguardando avaliação, até 2160 horas |
| `BATCH_SIZE` | `100` | Candidatos por lote, até 500 |
| `MAX_BATCHES` | `100` | Limite de lotes por execução, até 1000 |
| `HYPERDRIVE` | Binding de produção | Pool do PostgreSQL; tem precedência sobre `DATABASE_URL` |
| `DATABASE_URL` | Sem padrão | Conexão direta para desenvolvimento |
| `PG_CA_CERT` | Sem padrão | CA em PEM para conexão direta; aceita quebras escapadas `\n` |
| `MONGODB_URI` | Secret | Conexão com o MongoDB |
| `MONGODB_DATABASE` | Secret | Nome do banco que contém `notificacoes` |
| `DAILY_HOUR_UTC` | `11` no disparador | Hora UTC das três análises diárias, de 0 a 23 |

As antecedências de 30/7 dias e os intervalos de 24/48 horas são valores iniciais
configuráveis, sujeitos à validação do produto. Alterar uma faixa muda a identidade
dos novos avisos e pode produzir outra notificação para a mesma pendência.

## Publicação no Cloudflare

Os arquivos Wrangler apontam para a conta Astro e para o Hyperdrive
`astro-notification-db`, com cache de consultas desativado. A conexão com a origem
usa TLS `require`, conforme o ambiente existente. Conexões diretas de
desenvolvimento validam o CA separadamente.

Autentique o Wrangler na conta correta. O build não publica recursos:

```sh
npm run build
npm run deploy -- expiring-compliance
npm run secrets:upload -- expiring-compliance
```

Sem identificador, `build` e `deploy` processam os cinco Workers de regras e por
último o disparador. `secrets:upload` processa somente os cinco Workers de regras.
O envio de secrets lê o `.env` e transfere somente os dois campos
do MongoDB pela entrada padrão, sem colocar os valores na linha de comando.

Para uma nova instalação, publique primeiro as regras desabilitadas ou em simulação,
configure os secrets e confira as conexões e candidatos antes de habilitar gravação.
O Worker `missing-compliance` continuará bloqueado até implementar a aplicabilidade.

Na migração do agendamento:

1. Publicar as regras com o entrypoint `RuleJob` e testar `preview()`.
2. Publicar o [serviço de resumos](https://github.com/Astro-Inter/astro-session-summary-service)
   com `src/entrypoint.ts`, `ScheduledJob` e `triggers.crons=[]`, preservando `ENABLED`.
3. Publicar o disparador por último: `npm run deploy -- scheduler`.
4. Conferir os cinco Service Bindings, o Cron `0 * * * *` do disparador e a ausência
   de Cron no serviço de resumos e nos Workers de regras.

Não adicionar agendas individuais às regras. Para rollback da agenda, remover
primeiro o Cron do disparador, restaurar `0 * * * *` no serviço de resumos e
republicar esse serviço. Isso evita exceder a cota e evita dois disparadores de resumos.
As demais quatro agendas da conta não precisam ser modificadas.

Para pausar uma regra, defina `ENABLED=false` e publique somente aquele Worker.
Para pausar o conjunto, defina `ENABLED=false` no disparador e publique-o.
A versão
inicial não possui rotas públicas: `workers_dev` e URLs de preview de produção
estão desativados; o preview temporário do Wrangler é usado no desenvolvimento.

Para publicar a mudança de contrato numérico, pause primeiro o disparador e aguarde
as execuções anteriores terminarem. Alinhe o consumidor da API, publique todos os
Workers de regras e só então retome o disparador. Evite executar simultaneamente
produtores da versão antiga e da nova para a mesma regra: eles guardam o controle
de deduplicação em locais diferentes. Um rollback também deve começar pela pausa.

## Testes e observabilidade

- Testes de regras: identidade dos avisos, faixas de antecedência, IDs e escopo.
- SQL em PGlite: PostgreSQL real em WebAssembly, com fixtures isoladas, incluindo
  renovação, limites de datas, cancelamento e envios em análise.
- Execução: simulação sem MongoDB, paginação, deduplicação, falhas parciais,
  garantia do índice e fechamento das conexões.
- Runtime: os cinco Workers de regras iniciam no workerd, recebem eventos e chamadas
  RPC desabilitados sem credenciais; o disparador seleciona e chama os destinos corretos.
- CI: tipagem, testes, runtime e build dos seis bundles a cada alteração.

Os logs estruturados incluem `rule`, `runId`, duração, quantidade de candidatos,
inserções, duplicatas e lotes. Falhas usam `execution_failed` e código sanitizado,
sem registrar URI, senha, destinatário ou texto da notificação. O erro é
propagado ao runtime; não há promessa de retentativa automática. Consulte as
execuções no painel e reexecute após corrigir a causa.

O pipeline de gravação é coberto por testes com substitutos das collections; os
testes padrão e a simulação não escrevem no MongoDB real. Para executar os cinco
testes de integração explicitamente, configure as credenciais no `.env` e rode:

```sh
npm run test:mongo
```

Essa execução usa apenas collections temporárias `__astro_contract_<uuid>_*`,
removidas após cada teste. Ela verifica o conjunto exato de campos, evento opcional,
IDs numéricos, disputas pela mesma chave, concorrência entre chaves diferentes,
compatibilidade com chaves antigas, inicialização do contador, rollback após falha
e limite de precisão. Nenhuma collection de negócio é escrita pelo teste.

Na validação operacional de **16/10/2026**, os cinco destinos responderam aos
Service Bindings reais. A execução inicial criou três notificações automáticas;
uma segunda execução conservou exatamente três, sem alterar os documentos legados.
Naquela versão, os documentos usavam ObjectId e BSON Date e o índice único parcial
foi confirmado. A collection temporária de testes foi removida. A correção posterior
do contrato passou nos cinco testes de integração com `_id` numérico, BSON Date
e controle separado; isso não significa que essa correção já foi publicada.

## Referências

- [Documentação dos bancos do Astro](https://astro-inter.github.io/banco-de-dados/).
- [Modelo PostgreSQL](https://github.com/Astro-Inter/banco-de-dados/blob/main/database/scripts/1_create_table.sql).
- [Precedência da view de conformidades](https://github.com/Astro-Inter/banco-de-dados/blob/main/database/views/07_vw_conformidades.sql).
- [Consumo atual das notificações na API](https://github.com/Astro-Inter/astro-api/tree/main/src/main/java/com/astro/api/notification).
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
- [Limites do Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits/).
- [Cache de consultas no Hyperdrive](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
- [Certificados TLS do Aiven](https://aiven.io/docs/platform/concepts/tls-ssl-certificates).
