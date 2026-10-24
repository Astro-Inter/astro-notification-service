# Lembrete Android de eventos pendentes — SCRUM-617

Este é o **único push** enviado pelo serviço. Ele não encaminha automaticamente
os avisos de conformidade, prazos ou validações já gravados pelas outras regras.

- Título: **Eventos pendentes**.
- Mensagem: **Você tem eventos pendentes. Abra o Astro para conferir.**
- Colaborador: participação em evento ativo ainda não enviada ou rejeitada.
- Gestor: participações próprias e eventos sob sua responsabilidade com pendências
  da equipe ou conclusões aguardando validação. Não existe espera mínima de 48h.
- Excluir contas inativas, cargo/unidade inativos, vínculos inconsistentes entre
  workspaces e eventos cancelados. Prazo próximo não é requisito: qualquer pendência
  elegível conta. Envio em análise deixa de ser cobrança ao colaborador.

## Fluxo e contrato

1. O Android usa Firebase Authentication e o SDK Messaging para obter UID e token.
2. Registra diretamente no Firestore `fcm_tokens/{uid}/devices/{installationId}`.
   O documento contém apenas `token` e `updated_at`, timestamp do servidor.
3. O Worker `astro-notification-pending-events-push` seleciona destinatários no
   PostgreSQL e acessa somente a subcoleção de cada UID elegível.
4. Sem dispositivos, encerra aquele destinatário sem gravar um aviso no Mongo.
5. Com dispositivos, obtém um recibo de `DeliveryControl.deliverWithReceipt()` e
   registra um aviso genérico em `notificacoes`, sem `id_evento`, por usuário/ciclo.
6. Envia FCM HTTP v1 **data-only**, com `type=pending_events`, UID, `cycle_id`, ID
   numérico da notificação e texto genérico. O Android confirma a conta atual,
   aplica deduplicação visual e abre a lista de eventos ao tocar no aviso.

O histórico continua no MongoDB, com o mesmo JSON de seis campos (evento opcional).
Firestore armazena somente dispositivos. O Android nunca recebe uma chave de
serviço. Não existe API intermediária pública para cadastrar tokens.

## Periodicidade e falhas

O Cron compartilhado continua `0 * * * *`, sem novo Cron Trigger. Seu binding
`PUSH` chama `PendingPushJob.run(scheduledTime)` a cada hora. O Durable Object
`PendingPushCoordinator`, instância `<APP_ENV>:pending-events:v1`, abre um ciclo
apenas a cada **72 horas**, usando a hora original do disparo. Não usa `*/3` no
dia do mês, que não mantém três dias na virada dos meses.

Nas horas intermediárias, um ciclo concluído retorna `not_due` antes de consultar
bancos ou Firebase. Somente destinatários ainda pendentes do ciclo original podem
ser retomados. A pendência e o UID são revalidados antes de uma retomada. Novas
pendências entram na próxima checagem completa de 72h. Usuário sem token naquele
momento aguarda o ciclo seguinte, mesmo se instalar o aplicativo depois.

SQLite mantém checkpoint de paginação, destinatários e estado por dispositivo,
sem guardar o token FCM. A tentativa é persistida antes da chamada externa.
Falhas transitórias usam backoff de 1h, 2h, 4h e 8h, com até cinco tentativas no
ciclo, respeitando `Retry-After` quando informado. Um dispositivo aceito não é
reenviado porque outro falhou. Um ciclo novo não recupera lembretes antigos.

`UNREGISTERED` e `INVALID_ARGUMENT` específicos do FCM permitem remover somente
aquele token; erros genéricos de payload ou de permissão não apagam tokens.
A remoção exige a versão `updateTime` lida no Firestore: se o token tiver sido
renovado em paralelo, a precondição evita apagar o documento novo.

Não existe transação entre FCM e SQLite. Timeout ou interrupção depois do aceite
pode provocar uma nova chamada FCM do mesmo ciclo. O aplicativo guarda o ciclo
exibido por UID e filtra a repetição. O TTL é de 24h; aceite do FCM não comprova
recebimento nem exibição. Permissão negada, aparelho offline, aplicativo forçado
a parar e restrições do Android podem impedir a apresentação.

O coordenador serializa execuções concorrentes e limita o trabalho por rodada.
A consulta usa lotes de 100 e checkpoint persistente; os envios processam até
1.000 destinatários por execução e até 500 dispositivos por UID. No plano Free,
o orçamento mais restritivo é de **40 chamadas externas Firebase por rodada**,
incluindo OAuth, paginação, envio e exclusão. Isso preserva margem abaixo do
limite de 50 subrequests externas. Ao atingir o orçamento, retorna `deferred`
com `reason=request_budget` e continua os destinatários restantes no gatilho
horário seguinte, sem repetir os concluídos. A consulta de pendências abre um
ciclo a cada 72h; a distribuição pode ocupar mais de uma execução horária.

## Configuração

| Binding/secret | Destino | Uso |
| --- | --- | --- |
| `HYPERDRIVE` | Worker push | PostgreSQL, reaproveitando a conexão existente |
| `PUSH_CONTROL` | Worker push | `DeliveryControl` do serviço de persistência |
| `PUSHES` | Worker push | Durable Object com backend SQLite |
| `FIREBASE_PROJECT_ID` | Worker push | Mesmo projeto do `google-services.json` Android |
| `FIREBASE_CREDENTIALS_BASE64` | Worker push | JSON da conta de serviço em base64 |
| `ENABLED`, `DRY_RUN` | Worker push | Habilitação e proteção de gravação/envio |
| `PUSH` | Disparador | Service Binding para `PendingPushJob` |

O backend usa as APIs oficiais Firestore/FCM e Web Crypto RS256, com OAuth de
escopo `datastore` e `firebase.messaging`. O access token é reutilizado por até
uma hora, com margem de expiração. Não foi adicionada dependência de produção.

```sh
npm run check
npm test
npm run test:runtime
npm run build
npm run deploy -- pending-events-push
npm run secrets:firebase -- /caminho/arquivo.env
```

O script de secrets transfere somente os dois campos Firebase pela entrada
padrão do Wrangler e não imprime valores. Não enviar o `.env` inteiro para um
preview nem para o Android. A configuração pública Android deve continuar no
arquivo local ignorado pelo Git.

Para instalar: publicar o controlador com `deliverWithReceipt`, publicar o push
pausado, configurar os dois secrets e verificar `PendingPushJob.preview()` por
Service Binding. O preview consulta apenas PostgreSQL, sem tokens, Mongo ou FCM.
Revisar e publicar as regras da PR mobile, mantendo outros caminhos inalterados.
Habilitar o push e publicar o disparador com o novo binding por último. Para
pausar apenas os pushes, usar `ENABLED=false` nesse Worker; as outras regras
continuam operando normalmente. Preservar a identidade do Durable Object.

O mobile inclui dependências oficiais Messaging/Firestore na BoM existente,
cache SharedPreferences com heartbeat, permissão Android, proteção de logout e
filtro por UID/ciclo. Sem o aplicativo atualizado e um token cadastrado, não há
dispositivo para receber o lembrete.

O entrypoint interno `PendingPushJob.recheck(firebaseUid)` permite uma rechecagem
operacional explícita de uma única conta elegível no ciclo atual, por exemplo
depois de registrar um aparelho de teste. Não possui rota HTTP pública. A chamada
consulta novamente as pendências, recusa identidade ambígua ou alterada, preserva
a agenda e não apaga dispositivos aceitos nem seu backoff. Em seguida, `run()`
processa os destinatários pendentes. Isso não habilita envio automático no momento
do cadastro nem ignora a deduplicação do ciclo.

## Validação

- SQL executado em PGlite: múltiplas turmas, gestor/equipe, envio em análise,
  cancelamento, roles inativos, prazo indiferente e isolamento entre workspaces.
- OAuth: assinatura RS256 verificada com chave pública de teste; cache e escopos.
- Cliente Firebase: paginação, data-only, erro de payload, token inválido,
  remoção condicional, falha temporária e orçamento externo por rodada.
- SQLite: ciclo de 72h na virada do mês, retomada parcial, limite de tentativas,
  `Retry-After`, ausência de tokens, UID alterado e disparo antigo fora de ordem.
  A continuação por orçamento conserva os destinatários ainda não processados.
- Runtime workerd: binding do novo serviço e ID do recibo de notificação existente.
- Mobile: CI compila o APK, executa testes Java e testa as regras no emulador
  Firestore com projeto `demo-astro-push`, sem credenciais de produção.

A validação em aparelho deve abranger login, permissão, renovação, dois aparelhos,
logout offline/troca de conta, abertura em foreground/background e clique depois
de encerrar o processo. `validate_only` do FCM valida uma requisição, não substitui
o teste de recebimento em um aparelho registrado.

### Verificação operacional em 24/10/2026

O controlador de recibos, o Worker de push e o disparador foram publicados no
Cloudflare. O push está habilitado, fora de simulação, com os dois secrets
Firebase e sem Cron próprio. As regras do Firestore foram publicadas após os
testes de isolamento por UID; os demais caminhos permanecem bloqueados.

A consulta real identificou 70 usuários elegíveis. A execução e sua retomada
concluíram os 70, todos sem dispositivos cadastrados: nenhum push foi enviado e
nenhum aviso desse ciclo foi criado no Mongo. O estado final ficou sem
destinatários pendentes. O próximo ciclo é em **27/10/2026 às 14h UTC (11h em São
Paulo)**. Os logs `push_finished` foram observados no runtime e o destino nativo
`astro-grafana-logs` está configurado; não foi feita consulta de leitura no Grafana.

O FCM respondeu à validação de esquema/autorização com `validate_only`, usando
um token fictício. O recebimento real permanece dependente de instalar o Android
atualizado, autenticar, permitir notificações e confirmar seu registro no Firestore.

Referências: [FCM Android](https://firebase.google.com/docs/cloud-messaging/android/get-started),
[FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api),
[segurança do Firestore](https://firebase.google.com/docs/firestore/security/rules-conditions),
[limites de subrequests Cloudflare](https://developers.cloudflare.com/workers/platform/limits/#subrequests).
