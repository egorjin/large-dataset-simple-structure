FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY client/package.json ./client/package.json
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY client/package.json ./client/package.json
RUN npm install --omit=dev
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
EXPOSE 3000
CMD ["node", "server/index.js"]
