FROM python:3.13-slim
WORKDIR /app
COPY server.py ./
ENV PORT=__PORT__
EXPOSE __PORT__
USER nobody
CMD ["python", "server.py"]
