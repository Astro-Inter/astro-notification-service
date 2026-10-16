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

Os cinco começam com `ENABLED=false`, `DRY_RUN=true`, escopo de workspaces vazio e
`triggers.crons=[]`. Não há envio automático de notificações nesse estado.

Na preparação do ambiente em **15/10/2026**, o Cloudflare recusou novos
agendamentos com o código `10072`: a conta já usa os cinco Cron Triggers do plano
gratuito. As agendas dos outros serviços foram preservadas. Para habilitar as
agendas deste serviço, será necessário liberar capacidade ou alterar o plano.
Os horários abaixo são propostas, não agendas ativas.

## Workers e regras

| Identificador | Nome no Cloudflare | Responsabilidade | Agendamento proposto em UTC |
| --- | --- | --- | --- |
| `expiring-compliance` | `astro-notification-expiring-compliance` | Conformidades próximas do vencimento | `0 11 * * *` — diariamente, 08h em São Paulo |
| `expired-compliance` | `astro-notification-expired-compliance` | Conformidades vencidas | `5 11 * * *` — diariamente, 08h05 em São Paulo |
| `class-deadlines` | `astro-notification-class-deadlines` | Participações pendentes próximas do prazo da turma | `10 * * * *` — a cada hora, no minuto 10 |
| `pending-validations` | `astro-notification-pending-validations` | Conclusões aguardando avaliação do gestor | `15 11 * * *` — diariamente, 08h15 em São Paulo |
| `missing-compliance` | `astro-notification-missing-compliance` | Obrigações sem conformidade registrada | Sem agenda; aplicabilidade pendente |

### Conformidades

As análises de validade consideram colaboradores ativos, com cargo e unidade
ativos, registros aplicáveis e NRs não revogadas. O cargo e a unidade precisam
pertencer ao mesmo workspace, presente em `WORKSPACE_IDS`.

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

1. Verificar se a regra está habilitada e validar o escopo explícito de workspaces.
2. Consultar candidatos no PostgreSQL em transações somente de leitura, por lotes.
3. Montar as notificações e suas chaves de negócio.
4. Em simulação, contabilizar candidatos sem conectar ao MongoDB.
5. Com gravação habilitada, garantir os índices e executar upserts idempotentes.
6. Registrar contagens e duração e fechar as conexões da execução.

A paginação usa o último ID consultado, sem `OFFSET`. Se `MAX_BATCHES` for
atingido e ainda houver candidatos, a execução falha com `BATCH_LIMIT_REACHED`;
ela não informa sucesso ocultando registros restantes. Reduza o escopo ou ajuste
a capacidade antes da próxima execução. Falhas parciais podem ser reexecutadas:
os avisos já gravados serão reconhecidos pelas mesmas chaves.

As consultas são atuais por lote. PostgreSQL e MongoDB não participam de uma
transação distribuída; uma alteração na origem entre leitura e gravação pode
ocorrer. A frequência de execução não determina a frequência de notificação:
o mesmo fato não é recriado a cada consulta.

## Contrato no MongoDB

Collection: `notificacoes`. Os campos já consumidos pela API são preservados:

| Campo | Tipo BSON | Uso |
| --- | --- | --- |
| `_id` | ObjectId | Gerado pelo driver; não usa contador numérico |
| `id_usuario` | Número | Destinatário compatível com o modelo atual da API |
| `mensagem` | String | Texto exibido ao usuário |
| `data_criacao` | Date | Instante de criação do aviso, armazenado em UTC |
| `workspace_id` | Número | Workspace validado na origem |
| `tipo` | String | Identificador da regra |
| `recurso` | Documento | Tipo e ID do recurso de origem |
| `chave_deduplicacao` | String | Identidade estável do aviso |
| `regra_versao` | Número | Versão da regra que criou o documento |

A chave combina versão, regra, workspace, destinatário, recurso, data de
referência e faixa do aviso. Um índice único parcial protege essa chave,
inclusive em execuções concorrentes, sem exigir alterações nas notificações
antigas que não possuem esse campo. O upsert usa `$setOnInsert`: reexecuções
não alteram a mensagem nem a data de criação do aviso existente.

O índice de consulta é `(id_usuario ASC, data_criacao DESC, _id DESC)`. Os índices
são criados na primeira execução com gravação habilitada. Se o índice único não
puder ser garantido, nenhuma notificação será gravada por essa execução.
IDs incompatíveis com a precisão inteira do JavaScript são rejeitados, evitando
gravar um destinatário diferente por arredondamento.

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
  workers/       uma entrada por Worker
  rules/         consultas de candidatos por regra
  shared/        configuração, execução, PostgreSQL, MongoDB e notificações
workers/
  <regra>/wrangler.jsonc   configuração independente de publicação
scripts/         desenvolvimento, publicação, importação de credenciais e diagnóstico
tests/           regras, consultas SQL, persistência e execução
  runtime/       inicialização e eventos agendados dos cinco Workers no workerd
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

O modo local gera uma configuração ignorada em `.wrangler/local`, remove o
Hyperdrive de produção e usa `DATABASE_URL`. Conexões diretas remotas exigem TLS
com certificado verificado; para o Aiven, forneça o CA em `PG_CA_CERT`.
Conexões locais sem TLS precisam indicar `sslmode=disable` explicitamente.

Com o servidor aberto, `GET /health` verifica somente o processo.
`GET /__scheduled` dispara o evento de teste do Wrangler. Para testar a consulta,
configure `ENABLED=true`, mantenha `DRY_RUN=true` e informe `WORKSPACE_IDS`.

Para simular no Cloudflare usando o Hyperdrive já configurado:

```sh
npm run dev -- expired-compliance --remote --port 8787 --var ENABLED:true --var DRY_RUN:true --var WORKSPACE_IDS:1
```

Esse comando usa o workspace 1 como exemplo; informe apenas IDs autorizados para
o teste. O modo remoto usa um preview temporário e pode acessar o banco real.
`DRY_RUN=true` impede gravações e criação de índices no MongoDB.

O diagnóstico local `npm run connections:check -- <arquivo-env>` apenas consulta
o schema do PostgreSQL e executa `ping` no MongoDB; não modifica registros.

## Configurações

| Variável ou binding | Padrão | Significado |
| --- | --- | --- |
| `ENABLED` | `false` | Habilita a análise; aceita apenas `true` ou `false` |
| `DRY_RUN` | `true` | Simula sem abrir conexão de persistência com MongoDB |
| `WORKSPACE_IDS` | Vazio | Lista explícita de IDs, como `1,2`; vazia impede execução habilitada |
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

Sem identificador, `build`, `deploy` e `secrets:upload` processam os cinco Workers,
um de cada vez. O envio de secrets lê o `.env` e transfere somente os dois campos
do MongoDB pela entrada padrão, sem colocar os valores na linha de comando.

Antes de ativar, configure o escopo e valide os resultados em simulação. Quando
houver capacidade para novas agendas, preencha `triggers.crons` de cada Worker
com a expressão desejada, defina `ENABLED=true` e publique. Mantenha `DRY_RUN=true`
até concluir a conferência; só então altere para `false` e publique novamente.
O Worker `missing-compliance` continuará bloqueado até implementar a aplicabilidade.

Para pausar uma regra, defina `ENABLED=false` e publique somente aquele Worker.
Para remover sua agenda, use `triggers.crons=[]` na mesma configuração. A versão
inicial não possui rotas públicas: `workers_dev` e URLs de preview de produção
estão desativados; o preview temporário do Wrangler é usado no desenvolvimento.

## Testes e observabilidade

- Testes de regras: identidade dos avisos, faixas de antecedência, IDs e escopo.
- SQL em PGlite: PostgreSQL real em WebAssembly, com fixtures isoladas, incluindo
  renovação, limites de datas, cancelamento e envios em análise.
- Execução: simulação sem MongoDB, paginação, deduplicação, falhas parciais,
  garantia do índice e fechamento das conexões.
- Runtime: os cinco bundles iniciam no workerd e aceitam eventos agendados
  desabilitados sem precisar de credenciais.
- CI: tipagem, testes, runtime e build dos cinco bundles a cada alteração.

Os logs estruturados incluem `rule`, `runId`, duração, quantidade de candidatos,
inserções, duplicatas e lotes. Falhas usam `execution_failed` e código sanitizado,
sem registrar URI, senha, destinatário ou texto da notificação. O erro é
propagado ao runtime; não há promessa de retentativa automática. Consulte as
execuções no painel e reexecute após corrigir a causa.

O pipeline de gravação é coberto por testes com substitutos da collection; os
testes padrão e a simulação não escrevem no MongoDB real. A primeira ativação de
gravação deve conferir os índices e o consumo da API em ambiente de teste.

## Referências

- [Documentação dos bancos do Astro](https://astro-inter.github.io/banco-de-dados/).
- [Modelo PostgreSQL](https://github.com/Astro-Inter/banco-de-dados/blob/main/database/scripts/1_create_table.sql).
- [Precedência da view de conformidades](https://github.com/Astro-Inter/banco-de-dados/blob/main/database/views/07_vw_conformidades.sql).
- [Consumo atual das notificações na API](https://github.com/Astro-Inter/astro-api/tree/main/src/main/java/com/astro/api/notification).
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
- [Limites do Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits/).
- [Cache de consultas no Hyperdrive](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
- [Certificados TLS do Aiven](https://aiven.io/docs/platform/concepts/tls-ssl-certificates).
