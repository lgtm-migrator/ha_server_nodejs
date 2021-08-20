/*
  PURPOSE:  listen on UDP port 2001, process current gate state and forward computed state to WebSocket clients (browser UI)

  TODO:     periodic PING-PONG WebSocket, to detect and fix a broken channel
            reference at https://www.npmjs.com/package/ws#how-to-detect-and-close-broken-connections

*/

// import section
import { DotenvParseOutput } from 'dotenv';

import dgram from 'dgram';
import WebSocket from 'ws';
import { Server } from 'http';
import { requestJsonPromise } from '../utils/http-utils';

// global state variable that keeps track of Mongo connection
const serverUDP = dgram.createSocket('udp4');

enum STATES
{
    NO_INIT = 'NOT INITIALIZED',
    INIT = 'INIT',
    IDLE = 'IDLE',
    DEBOUNCE = 'DEBOUNCE',
    OPENING = 'OPENING',
    OPENED = 'OPENED',
    CLOSING = 'CLOSING',
    CLOSED = 'CLOSED'
}

export class UdpMonitoringService
{
    private envData: DotenvParseOutput;

    private counter: number;
    // oldTime: number = Date.now();
    private wss: WebSocket.Server;
    private timeHistory: { [from: string]: number };
    private currentGateState: String;
    private data;

    constructor(envData: DotenvParseOutput, serverHttp: Server)
    {
        this.envData = envData;
        this.counter = 0;
        this.timeHistory = {};
        this.currentGateState = STATES.NO_INIT;
        this.data = '00000';

        serverUDP.on('error', (err) =>
        {
            console.log(`serverUDP error:\n${err.stack}`);
            serverUDP.close();
        });

        serverUDP.on('listening', this.listeningStartedUDP());
        serverUDP.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => this.messageReceivedUDP(msg.toString(), rinfo));

        serverUDP.bind(2001);

        this.wss = new WebSocket.Server({ server: serverHttp }, () => { console.log('works !!!') });
        this.wss.on('connection', (ws: WebSocket) => this.wsConnectionStarted(ws));
    }


    private listeningStartedUDP(): () => void
    {
        return () =>
        {
            const address = serverUDP.address();
            console.log(`serverUDP listening ${address.address}:${address.port}`);
        };
    }


    private async messageReceivedUDP(msg: string, rinfo: dgram.RemoteInfo)
    {
        // console.log(rinfo.address);
        // return;

        let raw: any = null;
        try
        {
            raw = JSON.parse(msg);
            // console.log(`${msg}`);

            this.computeStateMachine(raw);  // no 'await' necessary, this will affect user experience

            const formattedData = this.formatIncomingData(raw);

            const printMsg = this.formatConsoleData(formattedData);

            this.wss.clients.forEach(socket =>
            {
                if (rinfo.address == this.envData.URL_HEARTBEAT_GATE_PING_ADDR) socket.send(`${this.currentGateState}`);
            });

            let elapsed: string | number;
            let timeNow: number = Date.now();

            elapsed = this.timeHistory[rinfo.address] ? timeNow - this.timeHistory[rinfo.address] : 'N/A';
            this.timeHistory[rinfo.address] = timeNow;

            console.log(`[UDP][RX]: ${printMsg} | ${(this.currentGateState as String).padStart(8, ' ')} | delta(ms): ${elapsed} | ${rinfo.address}`);

            // this.oldTime = timeNow;
            // this.timeHistory['from']

            // serverUDP.send(printMsg, 2001, '192.168.100.32');

            this.arduinoUdpFun();

            this.counter++;
        }
        catch (err)
        {
            console.log(`\n${err}: ${msg} \n`);
        }
    }


    private formatIncomingData(raw: any)
    {
        return {
            "ADC0": raw.ADC0.toString().padStart(8, " "),
            "ADC1": raw.ADC1.toString().padStart(8, " "),
            "avg0": raw.avg0.toString().padStart(8, " "),
            "avg1": raw.avg1.toString().padStart(8, " "),
            "read0": raw.read0.toString().padStart(8, " "),
            "read1": raw.read1.toString().padStart(8, " "),
            "stable": raw.stableSig.toString().padStart(2, " "),
            "state": raw.gateState.toString().padStart(2, " "),
            "RSSI": raw.RSSI.toString().padStart(4, " ")
        };
    }


    private formatConsoleData(formattedData: { ADC0: any; ADC1: any; avg0: any; avg1: any; read0: any; read1: any; stable: any; state: any; RSSI: any; })
    {
        return `{ "C":${this.counter}, "A0":${formattedData.ADC0}, "A1":${formattedData.ADC1}, "avg0":${formattedData.avg0}, "avg1":${formattedData.avg1}, "read0":${formattedData.read0}, "read1":${formattedData.read1}, "stable":${formattedData.stable}, "state":${formattedData.state}, "RSSI":${formattedData.RSSI} }`;
    }


    private async computeStateMachine(raw: any)
    {
        switch (raw.gateState)
        {
            case 1:
                this.currentGateState = STATES.IDLE;
                break;

            case 2:
                this.currentGateState = STATES.DEBOUNCE; // TODO - add timer to count how long does it take to open the gate and to send it directly via websocket !!
                break;

            case 3:
                if (this.currentGateState == STATES.DEBOUNCE) this.notifyGateOpening();
                this.currentGateState = STATES.OPENING;
                break;

            case 4:
                this.currentGateState = STATES.OPENED;
                break;

            case 5:
                if (this.currentGateState == STATES.DEBOUNCE) this.notifyGateClosing();
                this.currentGateState = STATES.CLOSING;
                break;

            case 6:
                this.currentGateState = STATES.CLOSED;
                break;

            default: this.currentGateState = STATES.INIT;
        }
    }


    private async notifyGateClosing()
    {
        {
            const wirePusherURL = `https://wirepusher.com/send?id=Wba8mpgaR&title=Gate Closing&message=${new Date().toLocaleTimeString('en-US')}&type=YourCustomType&message_id=${Date.now()}`;
            // console.log(wirePusherURL); //debug WIREPUSHER service
            await requestJsonPromise(wirePusherURL);
        }
    }


    private async notifyGateOpening()
    {
        const wirePusherURL = `https://wirepusher.com/send?id=Wba8mpgaR&title=Gate Opening&message=${new Date().toLocaleTimeString('en-US')}&type=YourCustomType&message_id=${Date.now()}`;
        console.log(wirePusherURL); // debug WIREPUSHER service

        await requestJsonPromise(wirePusherURL);
    }


    private async arduinoUdpFun()
    {
        const index = Math.floor(Math.random() * 5);
        const val = Math.floor(Math.random() * 10);

        this.data = this.data.substring(0, index) + val + this.data.substring(index + 1);

        // serverUDP.send(this.data, 8888, '192.168.1.39'); // fun with Arduino - test
        serverUDP.send(String(Math.floor(Math.random() * 10000)).padStart(4, '0'), 8888, '192.168.1.48'); // fun with Arduino - test
    }


    private wsConnectionStarted(ws: WebSocket)
    {
        ws.on('message', function incoming(message)
        {
            console.log(`received websocket: '${message}' from ${ws}`);
        });
    }
}
