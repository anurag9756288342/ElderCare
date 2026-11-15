# Production Google Cloud Run Dockerfile for ElderCare
FROM node:22-alpine

WORKDIR /usr/src/app

# Copy package manifests and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY server.js ./
COPY public ./public

# Cloud Run injects PORT=8080 by default
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Run as non-root user for container security
USER node

CMD ["node", "server.js"]
