FROM --platform=linux/amd64 node:22.11.0-bookworm-slim AS frontend-build

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /srv/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

COPY frontend ./
RUN npm run build

FROM --platform=linux/amd64 node:22.11.0-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    FRONTEND_DIST_DIR=frontend/dist

WORKDIR /srv

COPY package.json package-lock.json* ./
# `better-sqlite3` ships prebuilt binaries via a postinstall script. We can't
# use --ignore-scripts here without losing the native binding.
RUN npm install --omit=dev

COPY src ./src
COPY tsconfig.json ./
COPY --from=frontend-build /srv/frontend/dist ./frontend/dist

EXPOSE 8000

# tsx runs TypeScript directly; avoids a backend compile step and matches dev.
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
