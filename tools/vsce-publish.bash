#!/bin/bash

set -e

sops -d .env > .decrypted~.env
source .decrypted~.env
npx vsce publish -p "$VSCE_PAT"
rm .decrypted~.env
