# Grafana with its data source and dashboards built in, so the deployment needs no mounted files (Coolify copies the repository
# for the build only). Change a dashboard in grafana/dashboards, push, and redeploy.
FROM grafana/grafana-oss:13.0.2
COPY provisioning /etc/grafana/provisioning
COPY dashboards /var/lib/grafana-dashboards
