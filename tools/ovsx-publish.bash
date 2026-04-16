#!/bin/bash

set -e

sops -d .env > .decrypted~.env
source .decrypted~.env
rm .npmrc
npx ovsx publish -p $OVSX_TOKEN
rm .decrypted~.env
