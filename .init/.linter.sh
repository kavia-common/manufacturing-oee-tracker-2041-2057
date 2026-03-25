#!/bin/bash
cd /home/kavia/workspace/code-generation/manufacturing-oee-tracker-2041-2057/frontend_react
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

