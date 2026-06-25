import { globalForecast } from "./server/forecast";

async function run() {
  try {
    const payload = [{
      creatorId: "123",
      genre: "Gaming",
      history: [
        { date: "2023-01-01", views: 100, followers: 10, uploads: 1, engagements: 5 },
        { date: "2023-01-02", views: 200, followers: 20, uploads: 0, engagements: 10 },
        { date: "2023-01-03", views: 200, followers: 20, uploads: 0, engagements: 10 },
        { date: "2023-01-04", views: 200, followers: 20, uploads: 0, engagements: 10 },
        { date: "2023-01-05", views: 200, followers: 20, uploads: 0, engagements: 10 },
      ]
    }];
    console.log("Calling globalForecast...");
    const res = await globalForecast(payload, 3);
    console.log("Result:", res);
  } catch (e) {
    console.error("Error:", e);
  }
}
run();
