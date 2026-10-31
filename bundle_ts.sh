#!/usr/bin/env bash

# Define output file
OUTPUT_FILE="combined_typescript.md"

# Clear the output file if it already exists
> "$OUTPUT_FILE"

# Find and append files
find src -type f -name "*.ts" ! -path "*/node_modules/*" ! -path "*/dist/*" | while read -r file; do
    echo "### File: $file"
    echo '```typescript'
    cat "$file"
    echo
    echo '```'
    echo
done > "$OUTPUT_FILE"

echo "Done! Generated $OUTPUT_FILE with full file contents."

