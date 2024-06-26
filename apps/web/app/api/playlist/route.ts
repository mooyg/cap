import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  generateM3U8Playlist,
  generateMasterPlaylist,
} from "@/utils/video/ffmpeg/helpers";

export const revalidate = 3599;

const allowedOrigins = [
  process.env.NEXT_PUBLIC_URL,
  "https://cap.link",
  "cap.link",
];

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin") as string;

  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
        ? origin
        : "null",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get("userId") || "";
  const videoId = searchParams.get("videoId") || "";
  const videoType = searchParams.get("videoType") || "";
  const thumbnail = searchParams.get("thumbnail") || "";
  const origin = request.headers.get("origin") as string;

  if (!userId || !videoId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "userId or videoId not supplied",
      }),
      {
        status: 401,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }

  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      {
        status: 401,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }

  const video = query[0];

  if (video.public === false) {
    const user = await getCurrentUser();

    if (!user || user.userId !== video.ownerId) {
      return new Response(
        JSON.stringify({ error: true, message: "Video is not public" }),
        {
          status: 401,
          headers: {
            "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
              ? origin
              : "null",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
          },
        }
      );
    }
  }

  const bucket = process.env.CAP_AWS_BUCKET || "";
  const videoPrefix = `${userId}/${videoId}/video/`;
  const audioPrefix = `${userId}/${videoId}/audio/`;

  try {
    // Handle screen, video, and now audio types
    let objectsCommand, prefix;
    switch (videoType) {
      case "video":
        prefix = videoPrefix;
        break;
      case "audio":
        prefix = audioPrefix;
        break;
      case "master":
        prefix = null;
        break;
      default:
        return new Response(
          JSON.stringify({ error: true, message: "Invalid video type" }),
          {
            status: 401,
            headers: {
              "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
                ? origin
                : "null",
              "Access-Control-Allow-Credentials": "true",
              "Access-Control-Allow-Methods": "GET, OPTIONS",
            },
          }
        );
    }

    if (prefix === null) {
      const generatedPlaylist = await generateMasterPlaylist(
        process.env.NEXT_PUBLIC_URL +
          "/api/playlist?userId=" +
          userId +
          "&videoId=" +
          videoId +
          "&videoType=video",
        process.env.NEXT_PUBLIC_URL +
          "/api/playlist?userId=" +
          userId +
          "&videoId=" +
          videoId +
          "&videoType=audio"
      );

      return new Response(generatedPlaylist, {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      });
    }

    const s3Client = new S3Client({
      region: process.env.CAP_AWS_REGION || "",
      credentials: {
        accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
        secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
      },
    });

    objectsCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: thumbnail ? 1 : undefined,
    });

    const objects = await s3Client.send(objectsCommand);

    const chunksUrls = await Promise.all(
      (objects.Contents || []).map(async (object) => {
        const url = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: object.Key,
          }),
          { expiresIn: 3600 }
        );
        const metadata = await s3Client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: object.Key,
          })
        );

        return { url: url, duration: metadata?.Metadata?.duration ?? "" };
      })
    );

    const generatedPlaylist = await generateM3U8Playlist(chunksUrls);

    return new Response(generatedPlaylist, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
          ? origin
          : "null",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  } catch (error) {
    console.error("Error generating video segment URLs", error);
    return new Response(
      JSON.stringify({ error: error, message: "Error generating video URLs" }),
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }
}
