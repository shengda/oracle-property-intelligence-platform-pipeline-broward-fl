# Hosted Oracle: one AWS Lambda container (Lambda Web Adapter in front of the Fastify server).
# The published run is baked in: `cache/published/<MANIFEST_CID>/` must be synced and verified
# first (`npm run oracle -- sync --manifest <cid>`, which checks every file's sha256 against the
# manifest). See deploy/README.md.
#
#   docker build --platform linux/amd64 --build-arg MANIFEST_CID=<cid> -t oracle-broward .

# --- build: UI bundle and the server bundle -----------------------------------------------
FROM node:22.23.5-bookworm-slim AS build
WORKDIR /src
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY ui ui
RUN npm run ui:build \
 && npx esbuild src/hosted.ts --bundle --platform=node --format=esm --target=node22 \
      --packages=external --outfile=/out/src/hosted.mjs

# --- deps: production node_modules and the DuckDB extensions --------------------------------
FROM node:22.23.5-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY scripts/install-duckdb-extensions.mjs scripts/
RUN node scripts/install-duckdb-extensions.mjs /app/duckdb-ext

# --- runtime -------------------------------------------------------------------------------
FROM node:22.23.5-bookworm-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/duckdb-ext duckdb-ext
COPY --from=build /out/src/hosted.mjs src/hosted.mjs
COPY --from=build /src/ui/dist ui/dist
COPY cache/models cache/models
ARG MANIFEST_CID
COPY cache/published/${MANIFEST_CID} published
ENV NODE_ENV=production \
    HOME=/tmp \
    PORT=8080 \
    ORACLE_INDEX_DIR=/app/published \
    ORACLE_MANIFEST_CID=${MANIFEST_CID} \
    DUCKDB_EXTENSION_DIRECTORY=/app/duckdb-ext \
    DUCKDB_TEMP_DIRECTORY=/tmp/duckdb \
    AWS_LWA_READINESS_CHECK_PATH=/api/health \
    AWS_LWA_PASS_THROUGH_PATH=/events
EXPOSE 8080
CMD ["node", "src/hosted.mjs"]
