# OpenRadio (https://github.com/raj-khan/openradio, MIT) — self-hosted image.
# Build context: the pinned upstream checkout, /opt/openradio.
#   docker build -f /opt/openradio-host/Dockerfile -t openradio:local /opt/openradio
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Public origin baked into metadata, sitemap and robots at build time.
ARG NEXT_PUBLIC_APP_URL=https://openradio.ggz.ovh
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO /dev/null http://127.0.0.1:3000/ || exit 1
CMD ["npm", "start"]
