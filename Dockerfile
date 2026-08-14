# Build stage: compile TypeScript so the runtime image needs no dev toolchain.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Capacity is the memory dial: roughly 5 KB per trace, so 50k traces is about
# 256 MB of heap. Raise it only alongside the instance size.
ENV PORT=4500 CAPACITY=50000 SEED_COUNT=5000 INTERVAL_MS=1000
EXPOSE 4500

# The process holds all state in memory, so a stop is a full reset. Give it a
# moment to close sockets rather than being killed mid-broadcast.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4500)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
