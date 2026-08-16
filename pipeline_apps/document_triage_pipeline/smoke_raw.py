"""Smallest possible proof that the local model is reachable and answering.

Run this first, and run it again any time the demo misbehaves — it isolates
"is the service up?" from "is my pipeline wrong?".

    python smoke_raw.py
"""

from foundry_endpoint import CHAT_ALIAS, FoundryUnavailable, connect


def main() -> int:
    try:
        client, model_id, base_url = connect(CHAT_ALIAS)
    except FoundryUnavailable as exc:
        print(f"FAILED: {exc}")
        return 1

    print(f"Service:  {base_url}")
    print(f"Model:    {model_id}  (alias: {CHAT_ALIAS})")

    response = client.chat.completions.create(
        model=model_id,
        messages=[
            {"role": "system", "content": "You are a helpful local assistant. Be brief."},
            {"role": "user", "content": "Reply with exactly: local model online"},
        ],
        max_tokens=32,
        temperature=0.0,
    )

    print(f"Response: {response.choices[0].message.content.strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
