import json
import cv2
import os
import sys
from PIL import ImageFilter, Image


# Some kind of hardcoded path

directory = "/Users/clarkfan/Desktop/test_image/" + sys.argv[1]

cropped_image_directory = directory + '_output'

grey_scale_directory = directory + "_grey_scale"

if not os.path.exists(grey_scale_directory):
    # Create the folder
    os.makedirs(grey_scale_directory)

image_files = [
    filename
    for filename in os.listdir(cropped_image_directory)
    if filename.lower().endswith((".jpg", ".jpeg", ".png", ".gif", ".bmp"))
]

# Sort the image files in ascending order based on their names
sorted_image_files = sorted(image_files)
has_error = False
saved_exception = None
last_successful_image = None
processed_images = []
# Iterate over the sorted image files
try:
    for filename in sorted_image_files:
        image_path = os.path.join(cropped_image_directory, filename)
        edited_file_path = os.path.join(grey_scale_directory, filename)
        img = cv2.imread(image_path)

        # Convert the image to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Apply Gaussian blur to reduce noise
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)

        # Apply adaptive thresholding
        thresholded = cv2.adaptiveThreshold(
            blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2
        )

        # Invert the binary image to have text in white
        inverted = cv2.bitwise_not(thresholded)

        # - Morphological operations to further enhance text features
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))

        dilated = cv2.dilate(inverted, kernel, iterations=1)

        processedImage = cv2.erode(dilated, kernel, iterations=1)

        # Save the preprocessed image
        cv2.imwrite(edited_file_path, processedImage)
        processed_images.append(filename)
        last_successful_image = filename
except Exception as e:
    has_error = True
    saved_exception = e
    pass

output = {
    "processedImages": processed_images,
    "hasError": has_error,
    "lastSuccessfulImage": last_successful_image
}
print(json.dumps(output))
if has_error:
    raise saved_exception