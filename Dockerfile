# Imagen de Azure Lab: la app compilada + un servidor Node que guarda tu nube en el volumen /data.
# Lo normal es usarla con docker compose (ver docker-compose.yml):  docker compose up -d --build

# ---- Etapa 1: compilar. Aquí sí hacen falta TypeScript, Vite y las demás herramientas de desarrollo.
FROM node:24-slim AS build
WORKDIR /app
# Primero sólo las dependencias: si no cambian, Docker reutiliza esta capa y el build tarda segundos.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Etapa 2: ejecutar. Sólo lo imprescindible: ni código fuente, ni node_modules, ni herramientas.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY --from=build /app/dist ./dist
COPY server/server.mjs ./server/
# La carpeta de datos es del usuario sin privilegios "node", que es con el que se ejecuta el servidor.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
# Docker comprueba cada 30 s que la app responde (docker ps muestra "healthy").
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/server.mjs"]
