# Push imediato de chat — SCRUM-674

Worker separado astro-notification-chat-message-push, orientado a eventos,
sem Cron. Reutiliza FirebaseGateway, OAuth, Firestore e FCM HTTP v1 do serviço.
Não altera o lembrete periódico de eventos pendentes e não grava um aviso extra
na coleção notificacoes: o histórico da mensagem permanece no chat.

## Entrada e segurança

POST /internal/chat-messages, application/json, Authorization Bearer com
CHAT_PUSH_SECRET compartilhado apenas com a API Java. Segredo aleatório de
32–256 caracteres. Autentica antes de ler o corpo, limitado a 4.096 bytes.
ENABLED precisa ser true; padrão false. Não recebe tokens Firebase do usuário.

Corpo versão 1, exatamente onze campos:
version (número 1), messageId/conversationId (UUID), senderId/recipientId/workspaceId
(strings decimais positivas), recipientUid (Firebase UID), senderName (1–80 pontos
Unicode), preview (1–160 pontos Unicode), createdAt (ISO-8601, até 24h, tolerância
futura de 60s). IDs e identidade vêm da API autenticada, que aplica as regras do chat.
O Worker não consulta o PostgreSQL. Uma revogação posterior ao aceite não cancela
um evento já autorizado e enfileirado.

Respostas: 202 após persistência durável, 401 autenticação, 400 contrato inválido,
409 mesmo messageId com conteúdo diferente, 413 tamanho, 415 tipo, 503 desligado
ou indisponível, 404 rota inexistente, 405 método.

## Entrega e limites

Um Durable Object SQLite por messageId serializa o aceite e mantém o fingerprint.
Alarmes retomam o envio; repetição do mesmo evento confirma sem repetir dispositivos
concluídos e recria alarme perdido. Dispositivos vêm somente de
fcm_tokens/{recipientUid}/devices. Tokens não são persistidos no coordenador.
Sem dispositivos, termina o evento, sem recuperação retroativa após instalação.

Persistência precede cada tentativa FCM. Até oito tentativas por dispositivo,
vinte rodadas por evento e validade de 24h. Espera progressiva limitada a cinco
minutos, respeitando Retry-After do Firebase e o orçamento de 40 chamadas por rodada.
Token inválido é removido com precondição de versão Firestore.
Prévia é removida da storage ao concluir ou expirar, inclusive quando desabilitado.
Fingerprint sem conteúdo e recibo permanecem sete dias, depois são eliminados.

FCM usa data-only com type=chat_message, uid, message_id, conversation_id, sender_id,
sender_name, body, created_at. TTL restante até 24h; sem collapseKey entre mensagens.
O Android decide a exibição e deduplica por UID/messageId. Não existe entrega
exatamente uma vez: timeout após aceite FCM pode repetir uma chamada; os recibos
no Worker e aplicativo reduzem repetições. Aceite não confirma exibição/leitura.

## Configuração e teste

1. Configurar binding CHAT_PUSHES e migração SQLite v1, já declarados no wrangler.
2. Provisionar ingress HTTPS da infraestrutura para este Worker. workers_dev e
   preview estão desligados; não há hostname inventado nem rota publicada.
3. Cadastrar secrets FIREBASE_PROJECT_ID, FIREBASE_CREDENTIALS_BASE64 (mesma conta
   de serviço já autorizada para Firestore/FCM) e CHAT_PUSH_SECRET no novo Worker.
   O script secrets:firebase existente atende apenas pending-events-push; para
   este Worker usar secret bulk/put com --config workers/chat-message-push/wrangler.jsonc.
4. Habilitar ENABLED, publicar e configurar URL/segredo na API; ativar API por último.
   Publicação e entrega real não foram executadas nesta etapa.

Verificação local: npm run check; npm test; npm run test:runtime;
npm run build -- chat-message-push (dry-run). Testes cobrem autenticação,
contrato, parcial por dispositivo, retries, orçamento, prévia FCM, token inválido,
recibos/alarme SQLite em workerd e remoção de prévia expirada.
Seis testes Mongo condicionais continuam dependentes do ambiente de integração.
Validar depois com duas contas autorizadas e Android: aberto sem alerta, segundo
plano com prévia, toque, restauração, rede, duplicata, permissão e logout.
