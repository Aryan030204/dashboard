FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build --if-present
RUN npm prune --omit=dev

ENV NODE_ENV=production
# Node does hostname lookups on a shared pool of 4 threads by default. A larger pool keeps
# other lookups from queueing behind a slow one.
ENV UV_THREADPOOL_SIZE=16
EXPOSE 5005

CMD ["node", "app.js"]
