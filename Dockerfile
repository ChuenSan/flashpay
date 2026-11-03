# syntax=docker/dockerfile:1
FROM node:26.13.0-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY next.config.ts tsconfig.json next-env.d.ts postcss.config.mjs ./
COPY src ./src
COPY public ./public
RUN npm run db:generate && npm run build
RUN npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production \
    DATABASE_URL=file:/app/var/data/flashpay.db
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/next.config.ts ./
COPY --chown=node:node deploy/docker-entrypoint.sh ./deploy/docker-entrypoint.sh
RUN mkdir -p /app/var/data && chown -R node:node /app/var && chmod 700 /app/var/data
USER node
EXPOSE 3000
ENTRYPOINT ["sh", "/app/deploy/docker-entrypoint.sh"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
