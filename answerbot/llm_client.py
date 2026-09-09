import os

from openai import OpenAI

BASE_URLS = {
    "openai": None,
    "ollama": "http://localhost:11434/v1",
}

DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "ollama": "gemma4:e4b",
}


def chat(messages, provider, model=None):
    if provider not in BASE_URLS:
        raise ValueError(f"Unknown provider: {provider}")

    api_key = os.environ.get("OPENAI_API_KEY")
    if BASE_URLS[provider] is None and not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY must be set in the environment for the openai provider."
        )

    client = OpenAI(base_url=BASE_URLS[provider], api_key=api_key or "unused")
    completion = client.chat.completions.create(
        model=model or DEFAULT_MODELS[provider],
        messages=messages,
    )
    return completion.choices[0].message.content.strip()
