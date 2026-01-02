import Gamedig from 'gamedig';

export class QueryManager {
    static async query(type: string, host: string, port: number) {
        try {
            const state = await Gamedig.query({
                type: type as any,
                host: host,
                port: port,
                maxAttempts: 2,
                socketTimeout: 2000,
            });

            return {
                name: state.name,
                map: state.map,
                password: state.password,
                raw: state.raw,
                maxplayers: state.maxplayers,
                players: state.players.map((p: any) => ({
                    name: p.name,
                    raw: p.raw,
                })),
                bots: state.bots,
                connect: state.connect,
                ping: state.ping,
            };
        } catch (error) {
            throw new Error('Failed to query server');
        }
    }
}
