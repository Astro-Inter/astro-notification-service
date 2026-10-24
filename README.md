# Astro Notification Service

Serviço do Astro que consulta o PostgreSQL, identifica situações que exigem
atenção e registra notificações no MongoDB para consumo pela `astro-api`.
Ele acompanha prazos mesmo quando ninguém acessa ou altera o sistema.

Cada regra é um **Cloudflare Worker independente**, com configuração, publicação
e execução próprias. Eles consultam o PostgreSQL e encaminham as gravações para
um Worker técnico, `astro-notification-delivery-control`, que mantém o histórico
de entregas em um Durable Object SQLite no Cloudflare. No MongoDB, somente
`notificacoes` é usada.

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
| `delivery-control` | `astro-notification-delivery-control` | Reservar IDs, gravar avisos e confirmar entregas | Chamadas internas das regras; sem Cron |
| `pending-events-push` | `astro-notification-pending-events-push` | Lembrete genérico Android para colaboradores e gestores com eventos pendentes | Checagem a cada 72h; retomadas de falhas no gatilho horário existente |

### Push Android de eventos pendentes — SCRUM-617

O único push é “**Você tem eventos pendentes. Abra o Astro para conferir.**”, com
título “Eventos pendentes”. O gestor recebe também por pendências da equipe e
validações dos eventos sob sua responsabilidade. Não há filtro de proximidade
do prazo nem espera de 48h. As outras notificações persistidas no Mongo continuam
independentes e não são encaminhadas automaticamente ao Firebase.

O mobile registra dispositivos diretamente no Firestore. O novo Worker consulta
os UIDs elegíveis no PostgreSQL e envia FCM HTTP v1 por dispositivo, com ciclo
persistente de 72h e controle de repetição. Não há um novo Cron nem API pública
de cadastro de tokens. Consulte [a documentação completa](docs/push-firebase.md)
para contrato, credenciais, regras, limites, retomadas e validação no aparelho.

### Disparador compartilhado

O `astro-shared-scheduler` possui a única agenda deste conjunto de oito Workers.
O binding `SUMMARY` aponta para o entrypoint `ScheduledJob` do serviço de resumos;
`CLASSES`, `EXPIRING`, `EXPIRED` e `VALIDATIONS` apontam para `RuleJob` de cada regra.
`PUSH` aponta para `PendingPushJob`, que controla a cadência de 72h em SQLite.
O disparador não acessa bancos nem recebe credenciais deles.

As chamadas usam Service Bindings RPC e aguardam a execução do método `run()` de
cada destino. Não há endpoint HTTP público de processamento. `Promise.allSettled`
garante que uma falha não suprima os outros disparos; o resultado geral ainda
registra a falha e a propaga ao runtime. Cada serviço respeita sua habilitação.

Resumos, turmas e o controle de push são chamados a cada hora. As outras três regras entram na mesma
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
5. Com gravação habilitada, chamar o controle persistente, reservar o ID, garantir os índices e gravar em `notificacoes`.
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
| `_id` | Número | Inteiro positivo reservado pelo Durable Object; reutilizado nas tentativas da mesma entrega |
| `id_usuario` | Número | Destinatário compatível com o modelo atual da API |
| `titulo` | String | Título preenchido em todas as novas notificações |
| `mensagem` | String | Texto exibido ao usuário |
| `data_criacao` | Date | Instante de criação do aviso, armazenado em UTC |
| `id_evento` | Número, opcional | ID do evento nos avisos de prazo e de validação; ausente nos avisos de conformidade |

Exemplo completo em Extended JSON, sem campos adicionais:

```json
{
  "_id": 43,
  "id_usuario": 2,
  "mensagem": "Você tem uma participação pendente no evento “Treinamento”. O prazo termina em 2026-10-17 12:00:00 (horário de São Paulo).",
  "data_criacao": { "$date": "2026-10-16T12:00:00.000Z" },
  "id_evento": 1,
  "titulo": "Prazo de evento próximo do fim"
}
```

`id_evento` corresponde a `evento.id_evento`, convertido para número com validação
de precisão, e não ao ID da turma, da participação ou da conclusão. Os avisos de
conformidade omitem esse campo, sem gravar `null` ou um ID artificial.

Os títulos usados são “Conformidade próxima do vencimento”, “Conformidade
vencida”, “Prazo de evento próximo do fim” e “Conclusão aguardando avaliação”,
conforme a regra. O nome do evento permanece na mensagem.

No MongoDB, o serviço usa **somente `notificacoes`**, sem coleções auxiliares. Workspace,
regra, recurso, versão e chave de deduplicação não são adicionados ao documento.
A chave conserva a composição anterior: versão, regra, workspace, destinatário,
recurso, data de referência e faixa.

### Controle persistente no Cloudflare

O entrypoint interno `DeliveryControl` encaminha todas as entregas para a mesma
instância de `NotificationCoordinator`, identificada por
`<APP_ENV>:notificacoes:v1`. Seu armazenamento SQLite mantém a sequência numérica
e, para cada chave de negócio, o ID reservado, o estado `pending` ou `confirmed`,
a data inicial e uma impressão SHA-256 do conteúdo. Não são armazenadas cópias
das mensagens nem dos títulos nesse histórico.

O fluxo é **reservar e persistir → gravar no MongoDB → confirmar e persistir**.
As entregas são serializadas na instância; transações SQLite curtas protegem a
reserva e o avanço da sequência, sem manter uma transação aberta durante I/O.
Falhas não bloqueiam as chamadas seguintes. O índice nativo de `_id` no Mongo
protege a escrita repetida do mesmo documento.

Na inicialização, o contador parte do maior ID numérico existente abaixo de
`2^52`, respeitando os IDs importados. Novos IDs são sequenciais nessa faixa,
sem garantia de sequência sem lacunas: uma reserva pendente já ocupa seu número.
A faixa superior usada pela versão anterior permanece preservada e reconhecida;
novos IDs não dependem de hashes truncados. Outros produtores devem usar o mesmo
controle ou uma faixa numérica acordada; o serviço não coordena escritores externos.

Se a escrita falhar, a próxima execução elegível retoma o ID e a data reservados.
Se o Mongo gravar mas a confirmação falhar, a nova tentativa verifica o mesmo ID
e confirma sem sobrescrever o aviso. Um ID ocupado por conteúdo incompatível causa
`NOTIFICATION_ID_COLLISION`; conteúdo diferente para uma reserva pendente causa
`PENDING_CONTENT_MISMATCH`. Entregas já confirmadas retornam duplicata sem abrir
conexão com o Mongo. **Apagar um aviso confirmado não o torna elegível para reenvio.**

Não existe transação distribuída entre SQLite e MongoDB. Uma operação cujo
resultado ficou incerto permanece pendente até ser reconciliada em outra execução.
Se houver exclusão externa durante essa janela, a reserva ainda pendente pode
recriar o documento. A retomada depende de a regra voltar a selecionar o candidato;
não há fila nem retentativa autônoma para situações que deixaram de ser elegíveis.
O coordenador compartilhado prioriza consistência e serializa as gravações; seu
volume e os limites do plano Free devem ser acompanhados antes de ampliar a carga.

Avisos antigos com `chave_deduplicacao` continuam reconhecidos pela chave. IDs
numéricos positivos abaixo de `2^52` são reconhecidos por destinatário, mensagem
e evento (ou ausência dele). Seus IDs e documentos são preservados. Um ID já
associado no histórico à sua chave original não é confundido com outra faixa de
antecedência. Sem metadados suficientes, o fallback por conteúdo prioriza evitar
reenvios e pode agrupar faixas antigas iguais. Outros documentos legados sem
identidade são apenas preservados. O histórico disponível nas coleções removidas
pode ser importado por `DeliveryControl.importConfirmed()` em lotes de até 100
recibos `{ key, id }`, somente por Service Binding. ObjectIds antigos usam `id: null`.
Importações incompatíveis são rejeitadas integralmente.
`DeliveryControl.initialize()` valida a conexão, garante os índices e atualiza o
piso do contador sem diminuir seu valor. `status()` informa a inicialização e as
contagens de reservas e confirmações; ambos também são internos.

O índice de consulta é `(id_usuario ASC, data_criacao DESC, _id DESC)`. Os índices
são criados na primeira execução com gravação habilitada. Se o índice único não
puder ser garantido, nenhuma notificação será gravada por essa execução.
IDs incompatíveis com a precisão inteira do JavaScript são rejeitados, evitando
gravar um destinatário diferente por arredondamento.

O novo formato se aplica após publicar esta versão; não há migração automática
dos documentos existentes. A API precisa aceitar o histórico com ObjectId e os
novos IDs numéricos, além de mapear `titulo` e `id_evento`. Em **16/10/2026**, a
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
  workers/       entradas das regras, do controle persistente e do disparador
  scheduler/     seleção das tarefas horárias e diárias e despacho independente
  rules/         consultas de candidatos por regra
  control/       reservas, confirmações e sequência persistente em SQLite
  shared/        configuração, execução, PostgreSQL, MongoDB e notificações
workers/
  <regra>/wrangler.jsonc   configuração independente de publicação
scripts/         desenvolvimento, publicação, importação de credenciais e diagnóstico
tests/           regras, consultas SQL, persistência e execução
  runtime/       eventos, RPC e Durable Object SQLite no workerd
  integration/   contrato e concorrência no MongoDB real, somente por execução explícita
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
| `NOTIFICATION_CONTROL` | Service Binding das regras | Entrypoint `DeliveryControl` do Worker técnico |
| `DELIVERIES` | Durable Object no Worker técnico | Classe `NotificationCoordinator`, com backend SQLite |
| `MONGODB_URI` | Secret somente no Worker técnico | Conexão com o MongoDB |
| `MONGODB_DATABASE` | Secret somente no Worker técnico | Nome do banco que contém `notificacoes` |
| `DAILY_HOUR_UTC` | `11` no disparador | Hora UTC das três análises diárias, de 0 a 23 |
| `APP_ENV` | `production` no Cloudflare; `development` em dev | Ambiente registrado nos logs OTLP |
| `GRAFANA_OTLP_ENDPOINT` | Secret opcional | Base HTTPS do Grafana terminada em `/otlp`, ou URL completa `/otlp/v1/logs` |
| `GRAFANA_OTLP_HEADERS` | Secret opcional | Headers de autenticação OTLP; valores com percent encoding são decodificados |

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
npm run deploy -- delivery-control
npm run secrets:upload
npm run deploy -- expiring-compliance
```

Sem identificador, `build` e `deploy` processam primeiro o controle, depois os cinco
Workers de regras, o lembrete push e por último o disparador. `secrets:upload` processa somente
`delivery-control`; as regras não precisam de secrets do MongoDB.
O envio de secrets lê o `.env` e transfere somente os dois campos
do MongoDB pela entrada padrão, sem colocar os valores na linha de comando.

Para uma nova instalação, publique primeiro o controle, configure seus secrets
MongoDB e Grafana e publique as regras desabilitadas ou em simulação. Confira as
conexões e candidatos antes de habilitar gravação. A configuração usa a migração
`new_sqlite_classes`, compatível com o plano Free; não substitua por armazenamento KV legado.
O Worker `missing-compliance` continuará bloqueado até implementar a aplicabilidade.

Na migração do agendamento:

1. Publicar as regras com o entrypoint `RuleJob` e testar `preview()`.
2. Publicar o [serviço de resumos](https://github.com/Astro-Inter/astro-session-summary-service)
   com `src/entrypoint.ts`, `ScheduledJob` e `triggers.crons=[]`, preservando `ENABLED`.
3. Publicar o disparador por último: `npm run deploy -- scheduler`.
4. Conferir os seis Service Bindings, o Cron `0 * * * *` do disparador e a ausência
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

Para migrar o controle, publique primeiro o Worker técnico sem conectar as regras.
Pause o disparador e aguarde execuções anteriores terminarem. Preserve um snapshot
de `notificacoes` e importe os recibos disponíveis no backup de
`notificacoes_controle`, além das chaves legadas ainda presentes nos avisos.
Publique as cinco regras com o binding `NOTIFICATION_CONTROL`, valide o histórico
e uma reexecução e só então retome o disparador. As duas coleções auxiliares já
removidas não devem ser recriadas. Preserve o namespace do Durable Object e sua
identidade: apagá-lo ou trocar `APP_ENV` perde o acesso ao histórico daquela instância.
Um rollback deve começar pela pausa e preservar o histórico; voltar a um escritor
sem esse controle pode reenviar avisos ou disputar IDs já reservados.

## Testes e observabilidade

- Testes de regras: identidade dos avisos, faixas de antecedência, IDs e escopo.
- SQL em PGlite: PostgreSQL real em WebAssembly, com fixtures isoladas, incluindo
  renovação, limites de datas, cancelamento e envios em análise.
- Execução: simulação sem MongoDB, paginação, deduplicação, falhas parciais,
  garantia do índice e fechamento das conexões.
- Runtime: os cinco Workers de regras iniciam no workerd, recebem eventos e chamadas
  RPC desabilitados sem credenciais; o disparador seleciona e chama os destinos corretos.
- Controle: SQLite real, reserva durável, confirmação, importação e recuperação de falhas.
- CI: tipagem, testes, runtime e build dos oito bundles a cada alteração.

Os logs estruturados incluem `rule`, `runId`, duração, quantidade de candidatos,
inserções, duplicatas e lotes. Falhas usam `execution_failed` e código sanitizado,
sem registrar URI, senha, destinatário ou texto da notificação. O erro é
propagado ao runtime; não há promessa de retentativa automática. Consulte as
execuções no painel e reexecute após corrigir a causa.

### Logs no Grafana Cloud

Em produção, os oito Workers estão configurados para encaminhar o console
estruturado ao destino nativo `astro-grafana-logs`, com amostragem integral e
`persist=false` no Cloudflare. O push registra `push_finished` ou `push_failed`,
com contagens e códigos sanitizados, sem UID, token ou texto da mensagem. A
configuração do destino e suas credenciais são administradas na conta Cloudflare.
Esse caminho não exige secrets Grafana em cada Worker e não confirma, por si só,
uma consulta de leitura no painel de destino.

O serviço também oferece exportação direta opcional por OTLP/HTTP JSON. As
instruções abaixo descrevem essa alternativa; habilitá-la junto com o destino
nativo pode duplicar registros no Grafana.
Cada execução guarda um lote isolado em `AsyncLocalStorage` e aguarda o envio no
fim, tanto em sucesso quanto em falha. O mesmo mecanismo cobre Cron, RPC e preview.
Os contextos de execuções concorrentes não compartilham registros. As rotas HTTP
de saúde não geram um log de execução e os logs internos da plataforma Cloudflare
continuam disponíveis somente na observabilidade nativa.

O recurso OTLP identifica `service.name` pelo nome do Worker, `service.namespace`
como `astro` e `deployment.environment.name` por `APP_ENV`. O corpo é JSON com
evento, regra, `runId`, duração, contagens, resultado e código sanitizado. O
disparador inclui o horário agendado e o resultado de cada destino. Problemas de
conexão PostgreSQL e de fechamento dos bancos entram no contexto da execução.
Não são enviados dados dos destinatários, mensagens das notificações, consultas,
URIs dos bancos, credenciais ou objetos de exceção.

Para configurar, preencha os dois campos `GRAFANA_OTLP_*` no `.env` ignorado e
envie somente esses secrets aos oito Workers:

```sh
npm run secrets:grafana
# Também aceita um único destino:
npm run secrets:grafana -- scheduler
npm run deploy
```

O script usa a entrada padrão do Wrangler e não imprime os valores. Ele não envia
credenciais de banco ao disparador. `secrets:upload` continua tratando somente os
secrets MongoDB do Worker de controle. A base `/otlp` recebe o sufixo `/v1/logs`;
o sufixo não é repetido quando a URL já está completa. A autenticação aceita o
formato `Authorization=Basic%20<credencial-base64>`. Não há credenciais nos
arquivos Wrangler ou no Git.

No Grafana, selecione a fonte Loki em **Explore**, escolha o intervalo recente e use:

```logql
{service_name=~"astro-notification-.*|astro-shared-scheduler"} | json
```

Para investigar uma falha, acrescente `| event="execution_failed"`; para uma
execução específica, filtre por `runId` após o parser JSON. O disparador registra
`scheduler_finished` com `status="failed"` quando algum destino falha, ou
`scheduler_failed` se a própria execução não consegue ser iniciada corretamente.

O envio mantém os últimos 32 registros por execução, usa timeout de cinco segundos
e não segue redirects. Há um POST por execução com registros e configuração
completa. Sem configuração, o serviço mantém apenas o console do Cloudflare.
Uma falha de exportação não altera as notificações nem substitui o erro original.
Este envio direto não possui fila durável nem retentativa persistente; uma indisponibilidade
do Grafana pode causar perda do lote externo. A retenção no Cloudflare depende
da opção `persist`; atualmente ela está desativada em produção.

O console informa `telemetry_export_succeeded` quando o gateway aceita o lote,
`telemetry_export_failed` para status HTTP de erro, `telemetry_export_partial`
para rejeição parcial OTLP e `telemetry_unavailable` para timeout ou configuração
inválida. Esses diagnósticos não exportam respostas nem headers do provedor e não
geram recursão de telemetria. Essa validação confirma a ingestão; uma resposta de
aceite não equivale a uma consulta de leitura no painel do Grafana.

O pipeline de gravação é coberto por testes com substitutos das collections; os
testes padrão e a simulação não escrevem no MongoDB real. Para executar os seis
testes de integração explicitamente, configure as credenciais no `.env` e rode:

```sh
npm run test:mongo
```

Essa execução usa apenas coleções temporárias `__astro_contract_<uuid>`,
removidas após cada teste. Ela verifica o conjunto exato de campos, evento opcional,
IDs numéricos, disputas pela mesma chave, concorrência entre chaves diferentes,
compatibilidade com chaves antigas e IDs sequenciais, repetição após falha de
escrita, proteção contra conteúdo incompatível, IDs calculados antigos e bloqueio de reenvio após exclusão de aviso confirmado.
Nenhuma coleção de negócio é escrita pelo teste.

Na validação operacional de **16/10/2026**, os cinco destinos responderam aos
Service Bindings reais. A execução inicial criou três notificações automáticas;
uma segunda execução conservou exatamente três, sem alterar os documentos legados.
Naquela versão, os documentos usavam ObjectId e BSON Date e o índice único parcial
foi confirmado. A collection temporária de testes foi removida. A correção posterior
do contrato passou nos cinco testes de integração com `_id` numérico e BSON Date.
O contrato atual elimina as coleções de apoio conforme descrito acima.

Em **18/10/2026**, os cinco Workers de regras foram publicados com a persistência
em uma única coleção. Após backup local, `notificacoes_controle` e
`notificacoes_contadores` foram removidas. As quatro regras ativas concluíram
uma nova execução, reconheceram os oito avisos elegíveis sem inserções duplicadas
e não recriaram as coleções auxiliares. Os 26 documentos existentes em
`notificacoes` foram comparados com o snapshot anterior e permaneceram intactos.

A continuação dessa entrega adicionou `astro-notification-delivery-control` com
Durable Object SQLite. Foram importados oito recibos históricos, o contador foi
inicializado acima dos IDs existentes e uma execução das regras reconheceu cinco
avisos de prazo e três de validação sem novas inserções. O controle ficou com
oito confirmações e nenhuma entrega pendente; as 26 notificações permaneceram
intactas e as duas coleções removidas continuaram ausentes. Os secrets MongoDB
foram retirados das regras e mantidos somente no Worker técnico.

## Referências

- [Documentação dos bancos do Astro](https://astro-inter.github.io/banco-de-dados/).
- [Durable Objects com armazenamento SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
- [Planos e limites dos Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).
- [Modelo PostgreSQL](https://github.com/Astro-Inter/banco-de-dados/blob/main/database/scripts/1_create_table.sql).
- [Precedência da view de conformidades](https://github.com/Astro-Inter/banco-de-dados/blob/main/database/views/07_vw_conformidades.sql).
- [Consumo atual das notificações na API](https://github.com/Astro-Inter/astro-api/tree/main/src/main/java/com/astro/api/notification).
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
- [Limites do Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits/).
- [Cache de consultas no Hyperdrive](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
- [Certificados TLS do Aiven](https://aiven.io/docs/platform/concepts/tls-ssl-certificates).
- [Endpoint OTLP do Grafana Cloud](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/).
- [Protocolo OTLP e rejeições parciais](https://opentelemetry.io/docs/specs/otlp/).
