FROM node:22-alpine AS build
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG BUILD_REVISION
ARG SOURCE_DATE_EPOCH
ARG BUILD_DIRTY
RUN npm run build

FROM build AS test
RUN apk add --no-cache git
RUN npm test

FROM node:22-alpine AS runtime
RUN apk add --no-cache tzdata
ENV TZ=America/Los_Angeles
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
# /data holds config.json — the address of the settings store, written by
# the first-run wizard. Created here so the named volume mounted over it
# inherits this ownership and the unprivileged runtime user can write it.
RUN addgroup -S app && adduser -S app -G app \
 && mkdir -p /data \
 && chown -R app:app /app /data
USER app
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3200/healthz || exit 1
CMD ["node", "dist/server.js"]
