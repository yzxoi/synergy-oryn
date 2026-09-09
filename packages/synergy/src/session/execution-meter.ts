export namespace SessionExecutionMeter {
  export type Lease = { [Symbol.asyncDispose](): Promise<void> }
  const providers = new Map<string, (sessionID: string) => Promise<Lease | undefined>>()

  export function register(id: string, provider: (sessionID: string) => Promise<Lease | undefined>) {
    providers.set(id, provider)
    return () => providers.delete(id)
  }

  export async function begin(sessionID: string): Promise<Lease> {
    const leases: Lease[] = []
    try {
      for (const provider of providers.values()) {
        const lease = await provider(sessionID)
        if (lease) leases.push(lease)
      }
    } catch (error) {
      await Promise.all(leases.map((lease) => lease[Symbol.asyncDispose]()))
      throw error
    }
    return {
      async [Symbol.asyncDispose]() {
        await Promise.all(leases.map((lease) => lease[Symbol.asyncDispose]()))
      },
    }
  }
}
