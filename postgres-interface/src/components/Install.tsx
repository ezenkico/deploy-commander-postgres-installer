import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";

interface InstallProps{
    wire: RPCCaller
}

export default function Install({wire}: InstallProps){
    return <button onClick={() => {
        const user = "test_user";
        const password = "strongpassword";
        wire.start(
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
      }}>Install Postgres</button>
}