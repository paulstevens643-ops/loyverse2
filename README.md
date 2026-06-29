# White Swan Loyverse Menu Update

This package updates the Loyverse menu from `data/white_swan_loyverse_mapping.json`.

It creates missing categories, modifier groups, and items, and updates existing ones by name so duplicates are not created. Existing `Double` variants on matched items are made unavailable for sale; they are not hard-deleted.

## Setup

1. Add a GitHub repository secret named `LOYVERSE_TOKEN`.
2. Commit these files to the repository.
3. Open **Actions**.
4. Run **Update Loyverse Menu** manually.
5. Download the `loyverse-update-results` artifact to review the summary and verification output.

The token is read only from GitHub Secrets and is not stored in the repository.
