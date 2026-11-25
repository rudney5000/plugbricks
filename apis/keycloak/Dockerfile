# Image of the keycloak example brick: docker build -t ghcr.io/rudney5000/plugbricks/keycloak:0.1.0 apis/keycloak
# The official image, pinned by digest, built once for PostgreSQL with its health endpoints ("kc.sh build"),
# so that a new container starts with --optimized instead of rebuilding itself (84 s measured, D18).

FROM quay.io/keycloak/keycloak:26.7.3@sha256:29be7252db0a106f1cd2ac17b9a56ff2668073da645638a38b9fc67deeb2d6c4 AS build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7.3@sha256:29be7252db0a106f1cd2ac17b9a56ff2668073da645638a38b9fc67deeb2d6c4
COPY --from=build /opt/keycloak/ /opt/keycloak/
# The realm of the platform (roles plugbricks-admin and plugbricks-viewer, the admin's public client), without
# any user: imported on the first start only, Keycloak skips a realm that already exists.
COPY --chown=1000:0 realm.json /opt/keycloak/data/import/realm.json
COPY --chown=1000:0 --chmod=0555 entrypoint.sh /opt/keycloak/bin/plugbricks-entrypoint.sh
USER 1000
ENTRYPOINT ["/opt/keycloak/bin/plugbricks-entrypoint.sh"]
CMD ["start", "--optimized", "--import-realm"]
