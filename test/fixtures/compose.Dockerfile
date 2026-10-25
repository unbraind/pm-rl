FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
LABEL pm-rl-trainer="pm-rl-bandit"
WORKDIR /trainer
COPY package.json bandit.ts promotion.ts item-evaluation.ts process-bandit.ts tracker-record.ts ./
COPY scripts/script-launcher.ts ./scripts/
COPY test/fixtures/compose-trainer.ts ./test/fixtures/
ARG MODE=fit
ENV TRAINER_MODE=$MODE
ENTRYPOINT ["node", "--experimental-strip-types", "/trainer/test/fixtures/compose-trainer.ts"]
