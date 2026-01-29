import { httpRouter } from "convex/server";
import { WebhookEvent } from "@clerk/nextjs/server";
import { Webhook } from "svix";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";
import axios from "axios";

const http = httpRouter();

/* ===================== NVIDIA CONFIG ===================== */

const NVIDIA_API_URL =
  "https://integrate.api.nvidia.com/v1/chat/completions";

const NVIDIA_HEADERS = {
  Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
  "Content-Type": "application/json",
};

/* ===================== HELPER (NEW) ===================== */
// Removes ```json ... ``` wrappers so JSON.parse doesn't crash
function extractJSON(text: string) {
  return text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

/* ===================== CLERK WEBHOOK ===================== */

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error("Missing CLERK_WEBHOOK_SECRET environment variable");
    }

    const svix_id = request.headers.get("svix-id");
    const svix_signature = request.headers.get("svix-signature");
    const svix_timestamp = request.headers.get("svix-timestamp");

    if (!svix_id || !svix_signature || !svix_timestamp) {
      return new Response("No svix headers found", { status: 400 });
    }

    const payload = await request.json();
    const body = JSON.stringify(payload);

    const wh = new Webhook(webhookSecret);
    let evt: WebhookEvent;

    try {
      evt = wh.verify(body, {
        "svix-id": svix_id,
        "svix-timestamp": svix_timestamp,
        "svix-signature": svix_signature,
      }) as WebhookEvent;
    } catch (err) {
      console.error("Error verifying webhook:", err);
      return new Response("Error occurred", { status: 400 });
    }

    if (evt.type === "user.created") {
      const { id, first_name, last_name, image_url, email_addresses } = evt.data;
      await ctx.runMutation(api.users.syncUser, {
        clerkId: id,
        email: email_addresses[0].email_address,
        name: `${first_name || ""} ${last_name || ""}`.trim(),
        image: image_url,
      });
    }

    if (evt.type === "user.updated") {
      const { id, first_name, last_name, image_url, email_addresses } = evt.data;
      await ctx.runMutation(api.users.updateUser, {
        clerkId: id,
        email: email_addresses[0].email_address,
        name: `${first_name || ""} ${last_name || ""}`.trim(),
        image: image_url,
      });
    }

    return new Response("Webhooks processed successfully", { status: 200 });
  }),
});

/* ===================== VALIDATORS ===================== */

function validateWorkoutPlan(plan: any) {
  return {
    schedule: plan.schedule,
    exercises: plan.exercises.map((exercise: any) => ({
      day: exercise.day,
      routines: exercise.routines.map((routine: any) => ({
        name: routine.name,
        sets:
          typeof routine.sets === "number"
            ? routine.sets
            : parseInt(routine.sets) || 1,
        reps:
          typeof routine.reps === "number"
            ? routine.reps
            : parseInt(routine.reps) || 10,
      })),
    })),
  };
}

function validateDietPlan(plan: any) {
  return {
    dailyCalories: plan.dailyCalories,
    meals: plan.meals.map((meal: any) => ({
      name: meal.name,
      foods: meal.foods,
    })),
  };
}

/* ===================== GENERATE PROGRAM ===================== */

http.route({
  path: "/vapi/generate-program",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const payload = await request.json();
      const {
        user_id,
        age,
        height,
        weight,
        injuries,
        workout_days,
        fitness_goal,
        fitness_level,
        dietary_restrictions,
      } = payload;

      console.log("Payload is here:", payload);

      /* ---------- WORKOUT ---------- */

      const workoutPrompt = `You are an experienced fitness coach creating a personalized workout plan based on:
Age: ${age}
Height: ${height}
Weight: ${weight}
Injuries or limitations: ${injuries}
Available days for workout: ${workout_days}
Fitness goal: ${fitness_goal}
Fitness level: ${fitness_level}

Return ONLY valid JSON with this exact structure:
{
  "schedule": ["Monday"],
  "exercises": [
    {
      "day": "Monday",
      "routines": [
        { "name": "Exercise", "sets": 3, "reps": 10 }
      ]
    }
  ]
}`;

      const workoutRes = await axios.post(
        NVIDIA_API_URL,
        {
          model: "meta/llama-4-maverick-17b-128e-instruct",
          messages: [{ role: "user", content: workoutPrompt }],
          temperature: 0.4,
          max_tokens: 900,
        },
        { headers: NVIDIA_HEADERS }
      );

      let workoutPlan = JSON.parse(
        extractJSON(workoutRes.data.choices[0].message.content)
      );
      workoutPlan = validateWorkoutPlan(workoutPlan);

      /* ---------- DIET ---------- */

      const dietPrompt = `You are an experienced nutrition coach creating a personalized diet plan based on:
Age: ${age}
Height: ${height}
Weight: ${weight}
Fitness goal: ${fitness_goal}
Dietary restrictions: ${dietary_restrictions}

Return ONLY valid JSON with this exact structure:
{
  "dailyCalories": 2000,
  "meals": [
    { "name": "Breakfast", "foods": ["Food"] }
  ]
}`;

      const dietRes = await axios.post(
        NVIDIA_API_URL,
        {
          model: "meta/llama-4-maverick-17b-128e-instruct",
          messages: [{ role: "user", content: dietPrompt }],
          temperature: 0.4,
          max_tokens: 700,
        },
        { headers: NVIDIA_HEADERS }
      );

      let dietPlan = JSON.parse(
        extractJSON(dietRes.data.choices[0].message.content)
      );
      dietPlan = validateDietPlan(dietPlan);

      const planId = await ctx.runMutation(api.plans.createPlan, {
        userId: user_id,
        workoutPlan,
        dietPlan,
        isActive: true,
        name: `${fitness_goal} Plan - ${new Date().toLocaleDateString()}`,
      });

      return new Response(
        JSON.stringify({
          success: true,
          data: { planId, workoutPlan, dietPlan },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      console.error("Error generating fitness plan:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
        { status: 500 }
      );
    }
  }),
});

export default http;
