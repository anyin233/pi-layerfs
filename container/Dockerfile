# Same pinned Bookworm/Node base and package-manager setup as qualified LayerFS's
# runtime image; scripts/prepare.sh builds this stage alone as the Sandbox image.
FROM node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0 AS runtime
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0
RUN corepack enable \
 && corepack install --global pnpm@11.28.5 \
 && corepack prepare pnpm@11.7.0 pnpm@11.28.5 yarn@4.14.1 \
 && chmod -R a+rX /opt/corepack
ENV COREPACK_ENABLE_NETWORK=0 CI=1
FROM runtime
COPY container/package.json container/package-lock.json /opt/pi-runtime/
RUN cd /opt/pi-runtime && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
COPY dist /opt/pi-layerfs/dist
COPY src /opt/pi-layerfs/src
COPY vendor/layerfs /opt/pi-layerfs/vendor/layerfs
COPY bin /opt/pi-layerfs/bin
COPY scripts/container-entry.mjs scripts/release-smoke.mjs scripts/host-platform.sh scripts/project-smoke.mjs /opt/pi-layerfs/scripts/
COPY package.json README.md LICENSE THIRD_PARTY_NOTICES.md VERSION /opt/pi-layerfs/
RUN ln -s /opt/pi-runtime/node_modules /opt/pi-layerfs/node_modules \
 && chmod +x /opt/pi-layerfs/bin/pi-layerfs /opt/pi-layerfs/vendor/layerfs/bin/layerfs-daemon \
 && node -e "require('/opt/pi-layerfs/vendor/layerfs/node_modules/binding/layerfs.node')" \
 && test -x /opt/pi-layerfs/vendor/layerfs/bin/layerfs-daemon
ENV PI_CODING_AGENT_DIR=/layerfs-store/pi-agent \
    PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 UV_THREADPOOL_SIZE=64
LABEL org.opencontainers.image.title="pi-layerfs" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.source="https://github.com/anyin233/pi-layerfs" \
      org.opencontainers.image.licenses="MIT" \
      pi-layerfs.upstream="ad78914e36b258b360daf13aec164b5655814689"
WORKDIR /opt/pi-layerfs
ENTRYPOINT ["/usr/bin/env"]
CMD ["node", "/opt/pi-layerfs/scripts/container-entry.mjs"]
