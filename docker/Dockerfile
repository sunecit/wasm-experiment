# Сборка и проверка приложения выполняются внутри контейнера.
FROM node:24.15.0-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY sut ./sut
RUN npm test && npm run build

# Веб-сервер не содержит локальной копии централизованной доставки.
FROM nginx:1.27.5-alpine AS web
COPY docker/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/dist/index.html /usr/share/nginx/html/index.html
COPY --from=build /workspace/dist/assets /usr/share/nginx/html/assets
COPY --from=build /workspace/dist/mfes /usr/share/nginx/html/mfes
COPY --from=build /workspace/dist/shared /usr/share/nginx/html/shared
COPY --from=build /workspace/dist/build-artifacts.json /usr/share/nginx/html/build-artifacts.json
EXPOSE 8080

# Общий WASM-файл подхода Б отдаёт отдельный сервис.
FROM nginx:1.27.5-alpine AS delivery
COPY docker/delivery.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/dist/delivery /usr/share/nginx/html
EXPOSE 8080

# Версия браузерного образа совпадает с версией Playwright в package-lock.json.
FROM mcr.microsoft.com/playwright:v1.55.0-noble AS checks
WORKDIR /workspace
# Используем ту же версию Node.js, что и при локальной разработке и сборке.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/sut ./sut
COPY runner ./runner
COPY configs ./configs
RUN node --test runner/plan.test.mjs
CMD ["node", "runner/smoke.mjs"]


