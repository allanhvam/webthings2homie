import { WebThingsClient } from 'webthings-client';
import { client as WebSocketClient } from 'websocket';

interface ThingEvent {
    messageType: string,
    id: string,
    data: { [key: string]: any; }
}

var HomieDevice = require("homie-device");

(async () => {
    var config = {
        "name": "Mozilla WebThings",
        "device_id": "webthings",
        "mqtt": {
            "host": process.env["MQTT_HOST"],
            "port": 1883,
            "base_topic": "homie/",
        }
    }
    var homieDevice = new HomieDevice(config);
    homieDevice.setFirmware("webthings2homie", "1.0.0");

    let address = process.env["WEBTHINGS_HOST"];
    let accessToken = process.env["WEBTHINGS_TOKEN"];
    const webThingsClient = new WebThingsClient(address, 8080, accessToken);

    const devices = await webThingsClient.getDevices();
    let setProperties = new Array<() => void>();
    for (const device of devices) {
        const parts = device.href.split("/");
        const deviceId = parts[parts.length - 1];
        console.log(`Title: '${device.title}', id: '${deviceId}'`);
        var homieNode = homieDevice.node(deviceId, 'WebThings Device', device.selectedCapability);

        for (const propertyName in device.properties) {
            try {
                const property = device.properties[propertyName];
                const value = await webThingsClient.getProperty(property, propertyName);
                console.log(`${propertyName}: ${value}`);

                let name = propertyName;

                setProperties.push(() => {
                    let node = homieDevice.nodes[deviceId];
                    console.log(`${deviceId}, property ${name} set initial value ${value}`);
                    node.setProperty(name).send(String(value));
                });

                console.log(`${deviceId}, property ${propertyName}`);
                let homieProperty = homieNode.advertise(propertyName);
                // integer, float, boolean, string, enum, color
                switch (property.type) {
                    case "number":
                        homieProperty.setDatatype("integer");
                        break;
                    case "boolean":
                    case "string":
                        homieProperty.setDatatype(property.type);
                        break;
                    case "null":
                        break;
                    default:
                        throw new Error(`Unknown WebThings datatype '${property.type}'.`);
                }

                homieProperty.setName(property.title).settable(async (_range: any, value: any) => {
                    console.log(`From Homeie device ${deviceId} property ${propertyName} set to ${value}`);

                    // POST to WebThings
                    if (!property.readOnly) {
                        try {
                            let property = device.properties[propertyName];
                            webThingsClient.setProperty(property, propertyName, JSON.parse(value));
                        } catch (e) {
                            console.error(e);
                        }
                    } else {
                        // NOTE: for switches
                        let node = homieDevice.nodes[deviceId];
                        node.setProperty(propertyName).setRetained().send(value);
                    }
                });
            } catch (err) {
                console.error(err);
            }
        }
    }

    homieDevice.setup();

    setProperties.map(f => f());

    // Connect web sockets
    const thingUrl = `ws://${address}:8080/things`;
    const webSocketClient = new WebSocketClient();

    webSocketClient.on('connectFailed', function (error) {
        // TODO: wait and retry
        console.error(`Could not connect to ${thingUrl}: ${error}`);
    });

    webSocketClient.on("connect", function (connection) {
        console.log(`Connected to ${thingUrl}`);

        connection.on("error", function (error) {
            console.log(`Connection to ${thingUrl} failed: ${error}`);
        });

        connection.on("close", function () {
            console.log(`Connection to ${thingUrl} closed`);
            // TODO: wait and retry
        });

        connection.on('message', function (message) {
            if (message.type === 'utf8' && message.utf8Data) {
                const thingEvent = <ThingEvent>JSON.parse(message.utf8Data);

                if (thingEvent.messageType === 'propertyStatus') {
                    let deviceId = thingEvent.id;
                    console.log(`From WebThings update ${JSON.stringify(thingEvent.data)} in ${deviceId}`);

                    let keys = Object.keys(thingEvent.data);
                    for (let i = 0; i !== keys.length; i++) {
                        let key = keys[i];
                        let value = String(thingEvent.data[key]);
                        let node = homieDevice.nodes[deviceId];
                        node.setProperty(key).setRetained().send(value);
                    }
                }
            }
        });
    });

    webSocketClient.connect(`ws://${address}:8080/things?jwt=${accessToken}`);
})();