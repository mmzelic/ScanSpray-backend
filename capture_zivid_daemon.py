"""
GrayMatter Robotics - Zivid persistent daemon.
Connects to camera once on startup, then accepts CAPTURE commands via stdin.
Protocol:
  stdin:  CAPTURE <output_path>  |  QUIT
  stdout: READY                  (camera connected, ready for captures)
          SAVED:<output_path>    (capture succeeded)
          ERROR:<message>        (capture failed)
"""

import sys
import os
import zivid


def main(camera_ip: str) -> None:
    app = zivid.Application()

    print("CONNECTING", flush=True)
    camera = app.connect_camera()

    settings = zivid.Settings(
        acquisitions=[zivid.Settings.Acquisition()],
        color=zivid.Settings2D(acquisitions=[zivid.Settings2D.Acquisition()]),
    )

    print("READY", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == "QUIT":
            break
        if line.startswith("CAPTURE "):
            output_path = line[8:]
            try:
                out_dir = os.path.dirname(output_path)
                if out_dir:
                    os.makedirs(out_dir, exist_ok=True)
                frame = camera.capture_2d_3d(settings)
                image_rgba = frame.frame_2d().image_rgba_srgb()
                image_rgba.save(output_path)
                print(f"SAVED:{output_path}", flush=True)
            except Exception as e:
                print(f"ERROR:{e}", flush=True)
        else:
            print(f"ERROR:Unknown command: {line}", flush=True)


if __name__ == "__main__":
    camera_ip = sys.argv[1] if len(sys.argv) > 1 else ""
    main(camera_ip)
