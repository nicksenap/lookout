This is the crucial finding. The API is configured with:

```json
"subject_type_authorization": {
  "user":   { "policy": "require_client_grant" },
  "client": { "policy": "require_client_grant" }
}
```

That means **even user-delegated flows require an explicit client grant** — so Step 2 is mandatory, not optional. Let me check the logs for any activity to see the real behavior.
