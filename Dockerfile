FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dev
RUN mkdir -p /srv/tibelio/storage/development && chown -R node:node /srv/tibelio && chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json .npmrc ./
RUN npm ci
COPY --chown=node:node . .
ENV APP_ENV=development
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0"]

FROM base AS builder
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000 --maxsockets=5
COPY --chown=node:node . .
RUN npm run build
RUN node --input-type=module -e "import fs from 'node:fs'; import ts from 'typescript'; fs.writeFileSync('next.config.mjs', ts.transpileModule(fs.readFileSync('next.config.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText)"
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS prod
RUN mkdir -p /srv/tibelio/storage/production /srv/tibelio/backups && chown -R node:node /srv/tibelio && chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json .npmrc ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/.next ./.next
COPY --chown=node:node --from=builder /app/src ./src
COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/scripts ./scripts
COPY --chown=node:node --from=builder /app/supabase/migrations ./supabase/migrations
COPY --chown=node:node --from=builder /app/next.config.mjs ./
COPY --chown=node:node --from=builder /app/package.json ./
ENV APP_ENV=production
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
