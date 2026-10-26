FROM python:3.13-slim
WORKDIR /app
COPY server.py ./
ENV PORT=8112
EXPOSE 8112
USER nobody
CMD ["python", "server.py"]
