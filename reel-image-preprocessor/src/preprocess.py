import json
import os
import sys
import requests
from io import BytesIO
from PIL import ImageFilter, Image
import numpy as np
import easyocr
import collections
import Levenshtein
import time
import shutil


class ImagePreprocessor:
    def __init__(
        self,
        use_filter=True,
        use_binarization_threshold=0,
        is_local=True,
        verbose=False,
    ):
        # initializing the variables we'll need to process the images. The highly depends on the reel.
        self.use_filter = use_filter
        self.use_binarization_threshold = use_binarization_threshold
        self.is_local = is_local
        self.verbose = verbose

    def open_image_hosted(self, url):
        response = requests.get(url)
        image = Image.open(BytesIO(response.content))
        return image

    def open_image_local(self, path):
        image = Image.open(path)
        return image

    def preprocess(self, image):
        if self.verbose:
            print("Processing image shape: ", image.size)

        if self.use_filter:
            image = image.filter(ImageFilter.MinFilter(3))

        if self.use_binarization_threshold:
            image = image.point(lambda p: p > self.use_binarization_threshold and 255)

        if self.verbose:
            print("Processed image shape: ", image.size)

        return image

    def run(self, image_path):
        """
        This function will run the image processing pipeline

        :param image_path: path to the image
        :param is_local: if the image is local or hosted
        :return: processed image in a format that can be used by the model
        """

        if self.is_local:
            image = self.open_image_local(image_path)
        else:
            image = self.open_image_hosted(image_path)
        image = image.crop((x, y, x + width, y + height))
        image = self.preprocess(image)
        return np.array(image)


class ImageOCRProcessor:
    def __init__(self):
        self.reader = easyocr.Reader(
            ["en"]
        )  # this needs to run only once to load the model into memory

    def run(self, image):
        """
        This function will run the OCR pipeline

        :param image: image
        :return: text
        """
        text = self.reader.readtext(image)
        return text

    def run_batch(self, images, batch_size=8, preprocessor=None):
        """
        This function will run the OCR pipeline

        :param images: list of processed images or path to images. The latter case will need a preprocessor
        :param batch_size: batch size
        :param preprocessor: preprocessor to be used if the images are path to images. Needs to implement a run method path:string -> image:bytes
        :return: list of OCR outputs of the shape [](bbox, text, confidence)
        """
        ocr_output_list = []
        for i in range(0, len(images) // batch_size + 1):
            batch = images[i * batch_size : (i + 1) * batch_size]
            if preprocessor:
                batch = [preprocessor.run(image) for image in batch]

            batch_out = self.reader.readtext_batched(batch)
            for ocr_out in batch_out:
                ocr_output_list.append(ocr_out)

        return ocr_output_list


class ClusteringOCR:
    def __init__(self, verbose=False):
        self.verbose = verbose

    def get_centroid(self, bbox):
        x_coords = [point[0] for point in bbox]
        y_coords = [point[1] for point in bbox]
        centroid_x = sum(x_coords) / len(x_coords)
        centroid_y = sum(y_coords) / len(y_coords)
        return (centroid_x, centroid_y)

    def distance_between_points(self, p1, p2):
        return ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5

    def bbox_in_same_area(self, bbox1, bbox2, threshold=50):
        # Calculate the centroids of each bbox
        centroid1 = self.get_centroid(bbox1)
        centroid2 = self.get_centroid(bbox2)

        # Calculate the distance between the centroids
        distance = self.distance_between_points(centroid1, centroid2)

        # Check if the distance is less than the threshold
        return distance < threshold, distance

    def text_similarity(self, text1, text2):
        """
        This function will compute the similarity between two texts by comparing the number of common letters
        :param text1: first text
        :param text2: second text
        :return: similarity score between 0 and 1
        """
        text1 = text1.lower()
        text2 = text2.lower()
        common_letters = set(text1).intersection(set(text2))
        return len(common_letters) / max(len(text1), len(text2))

    def generate_stats_from_ocr_results(self, ocr_results):
        """
        This function will generate the stats used by the clustering from a list of ocr results
        Extracting the average bounding box, average text, and average confidence
        :param ocr_results: list of ocr results
        :return:
            average_bbox: average bounding box e.g [[345, 218], [580, 218], [580, 333], [345, 333]]
            std_bbox: standard deviation of the bounding box e.g {0: [0.1, 0.3], 1: [0.2, 0.0], 2: [0.1, 0.1], 3: [0.2, 0.2]}
            most_common_text_per_index: most common text at each index e.g {0: 'AMEL', 1: 'AT27C256R', 2: '70JU', 3: '2127'}
            text_frequency_per_index: text frequency at each index e.g {0: {'AMEL': 0.99, 'AS': 0.01}, 1: {'AT27C256R': 1}, 2: {'70JU': 1}, 3: {'2127': 1}}
            average_confidence: average OCR confidence at each index e.g {0: 0.99, 1: 0.70, 2: 0.01, 3: 0.99}
            most_frequent_number_word : the most frequent number of words in the ocr results
        """

        all_bbox = collections.defaultdict(list)
        outliers_num_words_count = 0
        all_text = collections.defaultdict(list)
        all_confidence = collections.defaultdict(list)

        # compute the most frerquent number of words
        number_words = [len(ocr_data) for ocr_data in ocr_results]
        most_frequent_number_word = collections.Counter(number_words).most_common(1)[0][
            0
        ]

        for ocr_data in ocr_results:
            if len(ocr_data) != most_frequent_number_word:
                outliers_num_words_count += 1
                continue
            for i, ocr_output in enumerate(ocr_data):
                bbox, text, confidence = ocr_output
                all_bbox[i].append(bbox)
                all_text[i].append(text)
                all_confidence[i].append(confidence)
        average_bbox = {k: np.mean(v, axis=0) for k, v in all_bbox.items()}
        std_bbox = {k: np.std(v, axis=0) for k, v in all_bbox.items()}
        most_common_text_per_index = {
            k: collections.Counter(v).most_common(1)[0][0] for k, v in all_text.items()
        }
        average_confidence = {k: np.mean(v) for k, v in all_confidence.items()}
        text_frequency_per_index = {
            k: collections.Counter(v) for k, v in all_text.items()
        }
        # normalize frequency
        for k, v in text_frequency_per_index.items():
            total = sum(v.values())
            for key, value in v.items():
                text_frequency_per_index[k][key] = value / total

        # if outliers_num_words_count is greater than 10% of the total number of images, then we print a warning

        # if outliers_num_words_count > 0.1 * len(ocr_results):
        #     print(
        #         f"Warning: {outliers_num_words_count} images were removed from the clustering because they have a different number of words than the most common number of words"
        #     )

        return (
            average_bbox,
            std_bbox,
            most_common_text_per_index,
            text_frequency_per_index,
            average_confidence,
            most_frequent_number_word,
        )

    def run(self, ocr_results, image_names, reference_indexes=[], bbox_threshold=50):
        """
        This function will run the clustering pipeline on a list of ocr results
        :param ocr_results: list of ocr results
        :param image_name: name of the image
        :param reference_indexes: list of indexes to check for anomalies
        :param bbox_threshold: threshold for the bbox clustering
        :return: list of anomalies in the format (image_name, []anomalies) where anomalies is a dictionary with the following, optional, keys:
            anomaly_name: name of the anomaly
            index: index of the anomaly
            confidence: confidence of the anomaly
            text: text of the anomaly
            reference_text: reference text
        """

        indexes_with_anomalies = (
            []
        )  # list of indexes with anomalies with the reason code e.g [(1, "different_subtext"), (3, "different_bbox")]
        (
            average_bbox,
            std_bbox,
            most_common_text_per_index,
            text_frequency_per_index,
            average_confidence,
            most_frequent_number_word,
        ) = self.generate_stats_from_ocr_results(ocr_results)
        # if self.verbose:
            # print("[i] Starting clustering with following stats : ")
            # print("average_bbox : ", average_bbox)
            # print("std_bbox : ", std_bbox)
            # print("most_common_text_per_index : ", most_common_text_per_index)
            # print("text_frequency_per_index : ", text_frequency_per_index)
            # print("average_confidence : ", average_confidence)
            # print("most_frequent_number_word : ", most_frequent_number_word)
            # print("reference_indexes : ", reference_indexes)
        # if reference_indexes is empty, then we use all indexes

        if len(reference_indexes) == 0:
            reference_indexes = list(range(most_frequent_number_word))

        for i in range(len(ocr_results)):
            ocr_data = ocr_results[i]

            if len(ocr_data) != most_frequent_number_word:
                indexes_with_anomalies.append(
                    (i, {"anomaly_name": "erroneous_number_of_words"})
                )
                continue

            for index_to_check in reference_indexes:
                ocr_output = ocr_data[index_to_check]
                bbox, text, confidence = ocr_output

                same_text = text == most_common_text_per_index[index_to_check]
                if not same_text:
                    indexes_with_anomalies.append(
                        (
                            i,
                            {
                                "anomaly_name": "erroneous_text",
                                "index": index_to_check,
                                "confidence": (
                                    1 - text_frequency_per_index[index_to_check][text]
                                )
                                * (
                                    1
                                    - self.text_similarity(
                                        text, most_common_text_per_index[index_to_check]
                                    )
                                ),
                                "text": text,
                                "reference_text": most_common_text_per_index[
                                    index_to_check
                                ],
                            },
                        )
                    )

                same_area, distance = self.bbox_in_same_area(
                    bbox, average_bbox[index_to_check], threshold=bbox_threshold
                )
                if not same_area:
                    indexes_with_anomalies.append(
                        (
                            i,
                            {
                                "anomaly_name": "erroneous_bbox",
                                "index": index_to_check,
                                "confidence": 1 - bbox_threshold / distance,
                            },
                        )
                    )

        # building the final output by concatenating the different anomalies for each image

        final_output = []
        for i in range(len(ocr_results)):
            ocr_data = ocr_results[i]
            image_name = image_names[i]
            anomalies = [
                anomaly for anomaly in indexes_with_anomalies if anomaly[0] == i
            ]
            if len(anomalies) > 0:
                final_output.append((image_name, anomalies))

        if self.verbose:
            # count per anomaly
            anomaly_count = collections.Counter(
                [anomaly[1]["anomaly_name"] for anomaly in indexes_with_anomalies]
            )
            print("[+] Clustering done...")
            print("Anomalies : ", anomaly_count)

        return most_common_text_per_index, final_output


def combine_string_from_dict(dictionary):
    return "".join(dictionary.values()).replace(" ", "")


def combine_string_from_array(array):
    return "".join(array).replace(" ", "")


def is_similar(string1, string2):
    # levenshtein distance: the minimum number of single-character edits
    distance = Levenshtein.distance(string1, string2)
    similarity = 1 - (distance / max(len(string1), len(string2)))
    return similarity >= 0.5


def move_files(file_paths, destination_directory):
    new_file_paths = []
    for file_path in file_paths:
        file_name = os.path.basename(file_path)
        destination_path = os.path.join(destination_directory, file_name)
        new_file_paths.append(destination_path)
        shutil.move(file_path, destination_path)
    return destination_directory


directory = "/Users/clarkfan/Desktop/test_image/" + sys.argv[1]

golden_sample = json.loads(sys.argv[2])

has_error = False
saved_exception = None
# Iterate over the sorted image files
try:
    x = golden_sample['cropArea']['x']
    y = golden_sample['cropArea']['y']
    width = golden_sample['cropArea']['width']
    height = golden_sample['cropArea']['height']

    destination_path = directory + "_anomaly"
    os.makedirs(destination_path, exist_ok=True)

    paths = [
        os.path.abspath(os.path.join(directory, filename))
        for filename in os.listdir(directory)
        if os.path.isfile(os.path.join(directory, filename))
        and filename.endswith((".jpg", ".jpeg", ".png", ".gif", ".bmp"))
    ]
    paths = sorted(paths)

    # Parameters
    # will change for every reel
    IS_PATH_LOCAL = True
    VERBOSE = False
    # no need to tune
    USE_IMAGE_FILTER = True
    USE_BINARIZATION_THRESHOLD = 0  # 0 for no binarization
    OCR_BATCH_SIZE = 16
    BBOX_DISTANCE_THRESHOLD = 50

    start_time = time.time()
    # Running the image processor for all the pictures. This works faster if ran on GPU.
    image_ocr_processor = ImageOCRProcessor()
    image_processor = ImagePreprocessor(
        use_filter=USE_IMAGE_FILTER,
        use_binarization_threshold=USE_BINARIZATION_THRESHOLD,
        is_local=IS_PATH_LOCAL,
        verbose=VERBOSE,
    )
    ocr_results = image_ocr_processor.run_batch(
        paths, batch_size=OCR_BATCH_SIZE, preprocessor=image_processor
    )

    end_time = time.time()
    execution_time = end_time - start_time
    # print(f"Execution time: {execution_time} seconds")
    # print("image processed: " + str(len(paths)))

    # Instancating the OCR clustering
    clustering_ocr = ClusteringOCR(verbose=True)

    # Running the clustering
    most_common_text_per_index, clustering_output = clustering_ocr.run(
        ocr_results, paths, reference_indexes=[], bbox_threshold=BBOX_DISTANCE_THRESHOLD
    )

    #  Displaying the result
    reference_string = combine_string_from_dict(most_common_text_per_index)
    anomaly_set = set()

    for cluster_res in clustering_output:
        image_name, anomalies = cluster_res
        ind = anomalies[0][0]
        ocr_text = []
        for k in range(len(ocr_results[ind])):
            bbox, ocr, confidence = ocr_results[ind][k]
            ocr_text.append(ocr)
        if len(ocr_text) == 0:
            anomaly_set.add(image_name)
            continue
        extracted_str = combine_string_from_array(ocr_text)
        if not is_similar(reference_string, extracted_str):
            anomaly_set.add(image_name)
            continue
    move_files(anomaly_set, destination_path)
except Exception as e:
    has_error = True
    saved_exception = e
    pass

output = {
    "anomalyPct": len(anomaly_set) / len(paths),
    "anomalyImages": destination_path,
    "hasError": has_error,
}
print(json.dumps(output))
if has_error:
    raise saved_exception