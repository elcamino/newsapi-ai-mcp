FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/index.js", "--http", "--host", "0.0.0.0", "--port", "8787"]
