import asyncio
from agent_framework import Agent
from agent_framework.foundry import FoundryLocalClient

async def main():
    agent = Agent(
        client=FoundryLocalClient(model="phi-4-mini"),
        name="SmokeTest",
        instructions="You are a helpful local assistant. Be brief.",
    )
    result = await agent.run("Reply with exactly: local model online")
    print(result)

asyncio.run(main())
