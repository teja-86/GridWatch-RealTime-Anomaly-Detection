FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

EXPOSE 4000

CMD ["sh", "-c", "npm run db:init && if [ \"$SEED_ON_STARTUP\" = \"true\" ]; then npm run db:seed; fi && node dist/src/server.js"]

