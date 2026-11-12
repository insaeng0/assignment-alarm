FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY web/server.js ./server.js
COPY web/src ./src
RUN mkdir -p /app/uploads/assignment-images && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
