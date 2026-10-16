# Astro Notification Service

Serviço agendado do Astro para analisar dados do PostgreSQL e criar notificações
no MongoDB, consumidas pela `astro-api`. Cada regra possui um Cloudflare Worker
independente, mantido neste repositório com código compartilhado.

Tarefa: [SCRUM-557](https://luizacursino.atlassian.net/browse/SCRUM-557).

## Estrutura inicial

- `src/workers`: uma entrada por regra.
- `src/shared`: execução e contratos compartilhados.
- `workers/<regra>/wrangler.jsonc`: publicação, variáveis e agendamento de cada Worker.
- `scripts/workers.mjs`: comandos para desenvolver, compilar e publicar.

Os Workers começam desabilitados (`ENABLED=false`) e em simulação
(`DRY_RUN=true`). O Worker de obrigações sem registro não possui agendamento:
a regra de aplicabilidade de cargo e unidade ainda precisa ser definida.

## Desenvolvimento

Requer Node.js 22 ou superior e npm.

```sh
npm ci
npm run check
npm run build
npm run dev -- expiring-compliance
```

Os identificadores são `expiring-compliance`, `expired-compliance`,
`class-deadlines`, `pending-validations` e `missing-compliance`.

`npm run build` valida todos os bundles sem publicar. `npm run deploy -- <regra>`
publica somente o Worker selecionado. Nunca versionar credenciais.
