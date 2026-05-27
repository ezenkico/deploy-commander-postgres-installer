import { useRef } from 'react';
import './App.css'
import { createWire, RPC, type RPCResponse, type WireSend } from "@ezenki/deploy-commander-installer-interface";

function setupWire(sendAction: (wire: WireSend) => Promise<RPCResponse>){
  const wire = createWire(sendAction);
  return RPC.SetupRPCCaller(wire);
}

export default function App() {
  const caller = useRef(setupWire(async() => {
    return {
      ok: true,
      result: null
    }
  }));

  return (
    <div className="p-6 text-xl font-semibold">
      <button onClick={() => {
        const user = "test_user";
        const password = "strongpassword";
        caller.current.start(
          "create", 
          "ezenki/deploy-commander-runner:latest",
          {
            services: {
              postgres: {
                image: "postgres:15",
                environment: {
                  "POSTGRES_USER": user,
                  "POSTGRES_PASSWORD": password
                },
                resources: [
                  {
                    "resource_type": "postgres",
                    "name": "postgres",
                    "metadata": {
                      user,
                      password
                    }
                  }
                ]
              }
            },
            volumes: [
              "postgres-data"
            ]
          }
        ).then(() => {
          console.log("started")
        })
        .catch((error) => {
          console.log(error);
        });
      }}>Start</button>
    </div>
  )
}
