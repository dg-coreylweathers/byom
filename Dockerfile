# Node 22+ per package.json engines. Slim rather than alpine: the SDK pulls in ws,
# which builds against the platform's libc, and glibc avoids a class of surprise.
FROM node:22-slim

WORKDIR /app

# Install from the lockfile only. `npm ci` fails loudly if the lockfile and
# package.json disagree, which is exactly the check we want in a build — a stale
# lockfile was a real finding in review (REVIEW.md B1).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY tools ./tools

# Never runs as root.
USER node

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
