FROM --platform=linux/amd64 node:22.11.0-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /srv

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

COPY src ./src
COPY tsconfig.json ./

EXPOSE 8000

# tsx runs TypeScript directly; avoids a compile step and matches dev.
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
