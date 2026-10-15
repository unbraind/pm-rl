FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
LABEL pm-rl-trainer="pm-rl-lm-fixture"
WORKDIR /trainer
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY *.ts ./
COPY scripts/script-launcher.ts ./scripts/
COPY test/fixtures/lm-compose-trainer.ts ./test/fixtures/
ARG MODE=fit
ENV TRAINER_MODE=$MODE
USER node
ENTRYPOINT ["node", "/trainer/test/fixtures/lm-compose-trainer.ts"]
