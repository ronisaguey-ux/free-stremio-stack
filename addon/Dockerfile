FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./

# The addon is dependency-free on purpose: nothing to audit, nothing to pin,
# and the image stays small enough to build on a laptop.
ENV NODE_ENV=production
EXPOSE 3819
USER node
CMD ["node", "server.js"]
