FROM node:22-alpine

# Small, predictable runtime. The app has zero npm dependencies, so there is
# nothing to install and no build step — just the source.
ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Source is copied with ownership already set so the unprivileged user can
# write to /app/data without a chown pass at runtime.
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public

# The rounds file lives here. Declaring it in the image means a named volume
# inherits these permissions when Docker first initialises it.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000

VOLUME ["/app/data"]

# Uses Node's built-in fetch, so the image stays free of curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/rounds').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Direct exec form: node runs as PID 1 and receives SIGTERM itself, which the
# server handles by flushing scores to disk before exiting.
CMD ["node", "server.js"]
