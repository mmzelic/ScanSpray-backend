"""
GrayMatter Robotics - Zivid 2D capture script.
Usage: python capture_zivid.py <output_path.png> <camera_ip>
"""

import sys
import os
import zivid


def main(output_path: str, camera_ip: str) -> None:
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    app = zivid.Application()

    print(f"Connecting to Zivid camera (expected IP: {camera_ip})")
    camera = app.connect_camera()

    settings = zivid.Settings(
        acquisitions=[zivid.Settings.Acquisition()],
        color=zivid.Settings2D(acquisitions=[zivid.Settings2D.Acquisition()]),
    )

    print("Capturing frame")
    frame = camera.capture_2d_3d(settings)

    image_rgba = frame.frame_2d().image_rgba_srgb()
    image_rgba.save(output_path)
    print(f"SAVED:{output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: capture_zivid.py <output_path> <camera_ip>", file=sys.stderr)
        sys.exit(1)

    main(output_path=sys.argv[1], camera_ip=sys.argv[2])
