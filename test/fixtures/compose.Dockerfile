FROM node:22-alpine
WORKDIR /trainer
COPY package.json bandit.ts promotion.ts process-bandit.ts ./
COPY scripts/script-launcher.ts ./scripts/
COPY test/fixtures/compose-trainer.ts ./test/fixtures/
ARG MODE=fit
ENV TRAINER_MODE=$MODE
ENTRYPOINT ["node", "--experimental-strip-types", "/trainer/test/fixtures/compose-trainer.ts"]
